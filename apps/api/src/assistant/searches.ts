// Saved buyer searches (A4; ARCHITECTURE §11; R-AST-5, R-AST-10, R-CONSENT-5, R-GATE-12).
//
// - Proposed by the assistant after a call: each criterion maps to a claim with call evidence; criteria
//   from needs-review (or conflicting) claims are prefilled but UNCHECKED and never stored as criteria
//   until the agent checks them (core.proposeSearch / applySearchReview).
// - Approved by the agent from the contact record, a human acting as themselves (DB trigger); criteria
//   changed after approval need re-approval in the same update (DB trigger). Activation starts alerts.
// - Phase 1 matches the team's own `listings` (active / coming soon). Alerts are `search_alert`,
//   purpose marketing, sent as the system through the send-time gate (never to an opted-out number,
//   brokerage name on every alert). A digest carries at most 3 homes; instant / daily / weekly.
// - Phase 2 (module 24, sole Phase 2 editor of this file; R-MLS-2, R-MLS-3, R-MLS-5, R-MLS-6): MLS rows join
//   the same path, so a new MLS match has exactly one sender. An MLS row is matched, previewed and alerted
//   only while mls/eligibility.ts says it may reach a client (live connection, counsel-reviewed pack with
//   attribution and disclaimer, fresh feed, broker allows internet display, not a mirror of a team
//   listing), and is rendered through core applyDisplayRules(client) with its listing brokerage and the
//   pack's attribution and disclaimer. Eligibility is re-read at queue time (stale data is never sent) and
//   the MLS compliance sweep cancels queued alerts whose MLS data stopped being eligible
//   (cancelIneligibleMlsAlertsInTx). The Owner's search_alert switch is the gate's, unchanged.
import { type Claim, CRITERION_KEYS, type CriterionKey, type ListingFacts, type SearchCriteria, SEARCH_ALERT, SearchCriteriaSchema, applySearchReview, formatPriceCents, hasCriteria, matchListing, proposeSearch, signOffFor } from '@realty/core/assistant';
import type { ContactId, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import type { DisplayListing } from '@realty/core/listings';
import { sql } from 'kysely';
import { LISTING_COLS, type ListingRow, type MlsEligibility, clientView, mlsEligibility } from '../mls/eligibility.js';
import { audit } from '../audit.js';
import { queueOutboundInTx } from '../comms/index.js';
import { asSystem, asUser } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import * as A from './repos/actions.js';
import { type ContactCore, contactCore, identityFacts } from './repos/context.js';
import { EMAIL_UNSUBSCRIBE_LINE, firstInThread } from './steps.js';
import type { AssistantDeps } from './types.js';

export const ALERT_DIGEST_MAX = 3;

interface SearchRow {
  id: string;
  contactId: string;
  name: string;
  status: 'proposed' | 'approved' | 'active' | 'paused' | 'archived';
  criteria: SearchCriteria;
  criterionEvidence: Record<string, string>;
  proposedByActionId: string | null;
  alertChannel: 'email' | 'sms';
  alertFrequency: 'instant' | 'daily' | 'weekly';
  lastAlertedAt: Instant | null;
  approvedAt: Instant | null;
}

type RawSearch = { id: string; contact_id: string; name: string; status: SearchRow['status']; criteria: unknown; criterion_evidence: Record<string, string>; proposed_by_action_id: string | null; alert_channel: 'email' | 'sms'; alert_frequency: SearchRow['alertFrequency']; last_alerted_at: Date | null; approved_at: Date | null };
const COLS = sql`id, contact_id, name, status, criteria, criterion_evidence, proposed_by_action_id, alert_channel, alert_frequency, last_alerted_at, approved_at`;
function row(x: RawSearch): SearchRow {
  const parsed = SearchCriteriaSchema.safeParse(x.criteria);
  return { id: x.id, contactId: x.contact_id, name: x.name, status: x.status, criteria: parsed.success ? parsed.data : ({} as SearchCriteria), criterionEvidence: x.criterion_evidence, proposedByActionId: x.proposed_by_action_id, alertChannel: x.alert_channel, alertFrequency: x.alert_frequency, lastAlertedAt: x.last_alerted_at ? (x.last_alerted_at.getTime() as Instant) : null, approvedAt: x.approved_at ? (x.approved_at.getTime() as Instant) : null };
}

async function searchById(tx: Tx, id: string, lock = false): Promise<SearchRow | null> {
  const r = lock
    ? await sql<RawSearch>`SELECT ${COLS} FROM saved_searches WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<RawSearch>`SELECT ${COLS} FROM saved_searches WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function searchContact(tx: Tx, id: string): Promise<string | null> {
  return (await searchById(tx, id))?.contactId ?? null;
}

// ---- proposal (call pipeline) ------------------------------------------------------------------------

/** Stores a proposal from search-proposal claims (in the caller's system transaction). Null: nothing to propose. */
export async function proposeSavedSearchInTx(tx: Tx, deps: AssistantDeps, tenantId: string, i: { contact: ContactCore; claims: readonly Claim[]; aiRunId: string | null; callId: string | null; inboundSeq: number; now: Instant }): Promise<{ searchId: string; actionId: string } | null> {
  const owner = i.contact.ownerUserId;
  if (!owner) return null;
  const withCriteria = i.claims.filter((c) => c.structured?.criterion !== undefined);
  const p = proposeSearch(withCriteria);
  if (!hasCriteria(p.criteria) && p.unchecked.length === 0) return null;
  const actionId = deps.ids.next<'AssistantActionId'>();
  const searchId = deps.ids.next<'SavedSearchId'>();
  const ok = await A.insertAction(tx, { envelope: deps.envelope, tenantId, ids: deps.ids }, {
    id: actionId,
    contactId: i.contact.id,
    kind: 'saved_search_proposal',
    category: 'internal',
    autonomy: 'internal',
    playbookVersionId: null,
    status: 'proposed',
    ownerUserId: owner,
    explanation: p.unchecked.length > 0 ? 'A saved search from the call. Some criteria need your check before they are used.' : 'A saved search from what they said on the call. Approve it to start alerts.',
    payload: { searchId, unchecked: p.unchecked, prefill: p.prefill },
    pinnedInboundSeq: i.inboundSeq,
    boundOwnershipSeq: i.contact.periodSeq,
    aiRunId: i.aiRunId,
    triggerRef: { kind: 'call_ready', ...(i.callId ? { callId: i.callId } : {}) },
    dedupeKey: i.callId ? `search_proposal:${i.callId}` : null,
    claims: withCriteria,
  });
  if (!ok) return null;
  await sql`
    INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence, proposed_by_action_id)
    VALUES (app.tenant_id(), ${searchId}, ${i.contact.id}, ${'Search from the call'}, 'proposed', ${JSON.stringify(p.criteria)}::jsonb,
            ${JSON.stringify(p.criterionEvidence)}::jsonb, ${actionId})`.execute(tx);
  await A.upsertFeed(tx, deps.ids, { userId: owner, itemType: 'saved_search_review', contactId: i.contact.id, subjectType: 'saved_search', subjectId: searchId, assistantActionId: actionId, score: 50, reasons: [{ code: 'SEARCH_PROPOSED', text: 'Saved search ready for your review' }], dedupeKey: `search:${searchId}` });
  return { searchId, actionId };
}

// ---- views ----------------------------------------------------------------------------------------------

export interface ListingView {
  id: string;
  /** 'mls' rows are never the team's own (R-MLS-4): the UI labels them with the listing brokerage */
  source: 'team' | 'mls';
  listingBrokerageName: string | null;
  addressLine1: string;
  city: string;
  postalCode: string;
  status: string;
  listPriceCents: number | null;
  beds: number | null;
  bathsX10: number | null;
  sqft: number | null;
  propertyType: string | null;
}

export interface SearchView {
  id: string;
  contactId: string;
  name: string;
  status: string;
  criteria: SearchCriteria;
  /** criterion key → the claim it came from (open its evidence on the proposal card) */
  criterionEvidence: Record<string, string>;
  /** prefilled but unchecked: from claims that need review (R-AST-5) */
  unchecked: string[];
  prefill: Record<string, unknown>;
  alertChannel: string;
  alertFrequency: string;
  matches: ListingView[];
}

type RawListing = ListingRow;
/**
 * The criteria facts of a row. core matchListing keeps the Phase 1 team-only guard (`source === 'team'`);
 * an MLS row reaches it only after `mlsMatchable` (the MLS rules), so its criteria are matched as a team
 * row's would be. Nothing else reads this value.
 */
const facts = (l: RawListing): ListingFacts => ({ source: 'team', status: l.status, postalCode: l.postal_code, city: l.city, region: l.region, listPriceCents: l.list_price_cents === null ? null : Number(l.list_price_cents), beds: l.beds, bathsX10: l.baths_x10, sqft: l.sqft, propertyType: l.property_type, description: l.description });
const listingView = (l: RawListing): ListingView => ({ id: l.id, source: l.source, listingBrokerageName: l.source === 'mls' ? l.listing_brokerage_name : null, addressLine1: l.address_line1, city: l.city, postalCode: l.postal_code, status: l.status, listPriceCents: l.list_price_cents === null ? null : Number(l.list_price_cents), beds: l.beds, bathsX10: l.baths_x10, sqft: l.sqft, propertyType: l.property_type });
const LCOLS = LISTING_COLS;

/** A team row always may be matched (Phase 1); an MLS row only while it may reach a client now. */
function mlsMatchable(e: MlsEligibility, l: RawListing): boolean {
  return l.source === 'team' || clientView(e, l) !== null;
}

/** SQL for client-eligible MLS rows (the cheap part of mlsMatchable; the display rules run after). */
const mlsEligibleSql = (e: MlsEligibility) =>
  sql`(l.source = 'team' OR (l.source = 'mls' AND l.display_allowed AND l.team_listing_id IS NULL AND l.mls_connection_id = ANY (${e.clientIds}::uuid[])))`;

/** Location / price / beds narrowing for the MLS candidate query (500k rows per tenant); matchListing decides exactly. */
function mlsPrefilter(c: SearchCriteria) {
  const parts = [sql`TRUE`];
  const zips = c.postalCodes ?? [];
  const cities = (c.cities ?? []).map((x) => x.city.trim().toLowerCase());
  if (zips.length > 0 || cities.length > 0) parts.push(sql`(left(l.postal_code, 5) = ANY (${zips}::text[]) OR lower(l.city) = ANY (${cities}::text[]))`);
  if (c.priceMinCents !== undefined) parts.push(sql`l.list_price_cents >= ${c.priceMinCents}`);
  if (c.priceMaxCents !== undefined) parts.push(sql`l.list_price_cents <= ${c.priceMaxCents}`);
  if (c.bedsMin !== undefined) parts.push(sql`l.beds >= ${c.bedsMin}`);
  return sql.join(parts, sql` AND `);
}

async function matchingListings(tx: Tx, c: SearchCriteria, limit: number, e: MlsEligibility): Promise<RawListing[]> {
  if (!hasCriteria(c)) return [];
  const team = await sql<RawListing>`
    SELECT ${LCOLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'team' AND l.status IN ('active','coming_soon')
     ORDER BY l.list_date DESC NULLS LAST, l.created_at DESC LIMIT 2000`.execute(tx);
  const mls =
    e.clientIds.length === 0
      ? { rows: [] as RawListing[] }
      : await sql<RawListing>`
    SELECT ${LCOLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.status IN ('active','coming_soon')
       AND ${mlsEligibleSql(e)} AND ${mlsPrefilter(c)}
     ORDER BY l.mls_modified_at DESC, l.id LIMIT 2000`.execute(tx);
  return [...team.rows, ...mls.rows].filter((l) => matchListing(c, facts(l)) && mlsMatchable(e, l)).slice(0, limit);
}

async function proposalPrefill(tx: Tx, s: SearchRow): Promise<{ unchecked: string[]; prefill: Record<string, unknown> }> {
  if (!s.proposedByActionId) return { unchecked: [], prefill: {} };
  const a = await A.actionById(tx, s.proposedByActionId);
  if (!a) return { unchecked: [], prefill: {} };
  return { unchecked: Array.isArray(a.payload.unchecked) ? (a.payload.unchecked as string[]) : [], prefill: (a.payload.prefill as Record<string, unknown>) ?? {} };
}

export async function previewSearch(actor: UserActor, searchId: string, deps: AssistantDeps): Promise<SearchView> {
  return asUser(deps, actor, async (tx, now) => {
    const s = await searchById(tx, searchId);
    if (!s) throw new AppError('NOT_FOUND');
    const p = s.status === 'proposed' ? await proposalPrefill(tx, s) : { unchecked: [], prefill: {} };
    return { id: s.id, contactId: s.contactId, name: s.name, status: s.status, criteria: s.criteria, criterionEvidence: s.criterionEvidence, unchecked: p.unchecked, prefill: p.prefill, alertChannel: s.alertChannel, alertFrequency: s.alertFrequency, matches: (await matchingListings(tx, s.criteria, 20, await mlsEligibility(tx, now))).map(listingView) };
  });
}

// ---- human commands -------------------------------------------------------------------------------------

export interface ApproveSearchInput {
  /** unchecked (needs-review) criteria the agent checked: their prefilled values are taken */
  checked: string[];
  removed?: string[] | undefined;
  edits?: Partial<SearchCriteria> | undefined;
  name?: string | undefined;
  alertChannel?: 'email' | 'sms' | undefined;
  alertFrequency?: 'instant' | 'daily' | 'weekly' | undefined;
}

const keysOf = (xs: readonly string[] | undefined): CriterionKey[] => (xs ?? []).filter((k): k is CriterionKey => (CRITERION_KEYS as readonly string[]).includes(k));

/** POST /saved-searches/:id/approve (R-AST-10: a human acting as themselves; DB trigger). */
export async function approveSearch(actor: UserActor, searchId: string, input: ApproveSearchInput, deps: AssistantDeps): Promise<SearchView> {
  await asUser(deps, actor, async (tx, now) => {
    const peek = await searchById(tx, searchId);
    if (!peek) throw new AppError('NOT_FOUND');
    await lockContact(tx, peek.contactId as ContactId);
    const s = (await searchById(tx, searchId, true))!;
    if (s.status === 'archived') throw new AppError('SAVED_SEARCH_STATE', { status: s.status });
    const p = await proposalPrefill(tx, s);
    const criteria = applySearchReview({ criteria: s.criteria, prefill: p.prefill as Partial<SearchCriteria> }, { checked: keysOf(input.checked), removed: keysOf(input.removed), ...(input.edits ? { edits: input.edits } : {}) });
    if (criteria === null || !hasCriteria(criteria)) throw new AppError('SAVED_SEARCH_INVALID');
    // approval after approval (criteria changed): approved_at moves forward in the same update (DB trigger)
    await sql`
      UPDATE saved_searches SET criteria = ${JSON.stringify(criteria)}::jsonb, status = CASE WHEN status = 'active' THEN 'active' ELSE 'approved' END,
             approved_by_user_id = ${actor.userId}, approved_at = GREATEST(${new Date(now).toISOString()}::timestamptz, COALESCE(approved_at, '-infinity'::timestamptz) + interval '1 microsecond'),
             name = COALESCE(${input.name ?? null}, name), alert_channel = COALESCE(${input.alertChannel ?? null}, alert_channel),
             alert_frequency = COALESCE(${input.alertFrequency ?? null}, alert_frequency)
       WHERE tenant_id = app.tenant_id() AND id = ${s.id}`.execute(tx);
    if (s.proposedByActionId) {
      const a = await A.actionById(tx, s.proposedByActionId);
      if (a && a.status === 'proposed' && a.ownerUserId === actor.userId) await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now });
      await A.resolveFeedFor(tx, s.proposedByActionId, now);
    }
    await audit(tx, actor, { action: 'saved_search.approved', entity: { type: 'saved_search', id: s.id }, reason: `criteria:${Object.keys(criteria).sort().join(',')}`.slice(0, 200) });
  });
  return previewSearch(actor, searchId, deps);
}

/** POST /saved-searches/:id/activate: alerts start (matches are recorded now; the alert job sends them). */
export async function activateSearch(actor: UserActor, searchId: string, deps: AssistantDeps): Promise<SearchView> {
  await asUser(deps, actor, async (tx, now) => {
    const peek = await searchById(tx, searchId);
    if (!peek) throw new AppError('NOT_FOUND');
    await lockContact(tx, peek.contactId as ContactId);
    const s = (await searchById(tx, searchId, true))!;
    if (s.status === 'active') return;
    if (s.status !== 'approved' && s.status !== 'paused') throw new AppError('SAVED_SEARCH_STATE', { status: s.status });
    await sql`UPDATE saved_searches SET status = 'active', activated_at = ${new Date(now).toISOString()}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${s.id}`.execute(tx);
    await audit(tx, actor, { action: 'saved_search.approved', entity: { type: 'saved_search', id: s.id }, reason: 'activated' });
  });
  await asSystem(deps, actor.tenantId, 'assistant', async (tx, now) => {
    await recordMatchesForSearch(tx, searchId, now);
    await sendDueAlertsInTx(tx, deps, actor.tenantId, now, { searchId });
  });
  return previewSearch(actor, searchId, deps);
}

/**
 * POST /saved-searches/:id/pause. Alerts already queued or scheduled for this search are canceled before
 * they reach the gate, and their matches are released
 * so they are alerted after a resume. Messages are system-written, so the cancel runs as the system right
 * after the agent's transaction, under the contact lock that dispatch also takes.
 */
export async function pauseSearch(actor: UserActor, searchId: string, deps: AssistantDeps): Promise<SearchView> {
  const contactId = await asUser(deps, actor, async (tx) => {
    const peek = await searchById(tx, searchId);
    if (!peek) throw new AppError('NOT_FOUND');
    await lockContact(tx, peek.contactId as ContactId);
    const s = (await searchById(tx, searchId, true))!;
    if (s.status === 'paused') return s.contactId;
    if (s.status !== 'active') throw new AppError('SAVED_SEARCH_STATE', { status: s.status });
    await sql`UPDATE saved_searches SET status = 'paused' WHERE tenant_id = app.tenant_id() AND id = ${s.id}`.execute(tx);
    return s.contactId;
  });
  await asSystem(deps, actor.tenantId, 'assistant', async (tx) => {
    await lockContact(tx, contactId as ContactId);
    await cancelQueuedAlerts(tx, searchId, 'SAVED_SEARCH_PAUSED');
  });
  return previewSearch(actor, searchId, deps);
}

/** Cancels a search's alerts that have not been dispatched yet and releases their matches (system). */
export async function cancelQueuedAlerts(tx: Tx, searchId: string, reason: string): Promise<string[]> {
  const s = await searchById(tx, searchId);
  if (!s || s.status === 'active') return [];
  const r = await sql<{ id: string }>`
    UPDATE messages m SET status = 'canceled', status_reason = ${reason}
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${s.contactId} AND m.direction = 'outbound' AND m.status IN ('queued','scheduled')
       AND m.id IN (SELECT x.alerted_message_id FROM saved_search_matches x WHERE x.tenant_id = app.tenant_id() AND x.search_id = ${s.id} AND x.alerted_message_id IS NOT NULL)
    RETURNING m.id`.execute(tx);
  const ids = r.rows.map((x) => x.id);
  if (ids.length > 0) {
    await sql`UPDATE saved_search_matches SET alerted_message_id = NULL WHERE tenant_id = app.tenant_id() AND search_id = ${s.id} AND alerted_message_id = ANY (${ids}::uuid[])`.execute(tx);
    // the frequency window counts from the last alert that was not canceled
    await sql`
      UPDATE saved_searches ss SET last_alerted_at = (
        SELECT max(m.created_at) FROM saved_search_matches x JOIN messages m ON m.tenant_id = x.tenant_id AND m.id = x.alerted_message_id
         WHERE x.tenant_id = ss.tenant_id AND x.search_id = ss.id)
       WHERE ss.tenant_id = app.tenant_id() AND ss.id = ${s.id}`.execute(tx);
  }
  return ids;
}

// ---- matching + alerts (system) ---------------------------------------------------------------------------

async function recordMatchesForSearch(tx: Tx, searchId: string, now: Instant): Promise<number> {
  const s = await searchById(tx, searchId);
  if (!s || s.status !== 'active') return 0;
  let n = 0;
  for (const l of await matchingListings(tx, s.criteria, 200, await mlsEligibility(tx, now))) {
    const r = await sql`
      INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES (app.tenant_id(), ${s.id}, ${l.id}, ${new Date(now).toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING`.execute(tx);
    n += Number(r.numAffectedRows ?? 0n);
  }
  return n;
}

/** matchSavedSearches body: one listing against every active search of the tenant. */
export async function matchListingInTx(tx: Tx, deps: AssistantDeps, tenantId: string, listingId: string, now: Instant): Promise<number> {
  const r = await sql<RawListing>`SELECT ${LCOLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId}`.execute(tx);
  const l = r.rows[0];
  if (!l) return 0;
  if (l.source === 'mls' && !mlsMatchable(await mlsEligibility(tx, now), l)) return 0; // R-MLS-2/3/5
  const searches = await sql<RawSearch>`SELECT ${COLS} FROM saved_searches WHERE tenant_id = app.tenant_id() AND status = 'active' ORDER BY id`.execute(tx);
  let n = 0;
  for (const s of searches.rows.map(row)) {
    if (!matchListing(s.criteria, facts(l))) continue;
    const ins = await sql`
      INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES (app.tenant_id(), ${s.id}, ${l.id}, ${new Date(now).toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING`.execute(tx);
    n += Number(ins.numAffectedRows ?? 0n);
  }
  if (n > 0) await sendDueAlertsInTx(tx, deps, tenantId, now, {});
  return n;
}

/** BUILD_PLAN interface: on listing insert / price change (api/workspace enqueues assistant.match_listing; a scan backs it up). */
export async function matchSavedSearches(actor: SystemActor, listingId: string, deps: AssistantDeps): Promise<void> {
  await withTenantTx(actor, (tx, now) => matchListingInTx(tx, deps, actor.tenantId, listingId, now), { db: deps.db, retries: 2 });
}

/** Listings created, changed or re-priced in the last `windowMs` (the periodic scan overlaps; matches are deduped by key). */
export async function recentlyChangedListings(tx: Tx, now: Instant, windowMs: number): Promise<string[]> {
  const since = new Date(now - windowMs).toISOString();
  const r = await sql<{ id: string }>`
    SELECT id FROM listings WHERE tenant_id = app.tenant_id() AND source = 'team' AND status IN ('active','coming_soon') AND updated_at > ${since}::timestamptz
    UNION SELECT listing_id FROM listing_price_history WHERE tenant_id = app.tenant_id() AND changed_at > ${since}::timestamptz LIMIT 500`.execute(tx);
  return r.rows.map((x) => x.id);
}

const PERIOD_MS = { instant: 0, daily: 86_400_000, weekly: 7 * 86_400_000 } as const;

/** One MLS home as the licence pack lets a client see it (fields it withholds are left out). */
function mlsHomeLine(v: DisplayListing): string {
  const where = v.address ? `${v.address.line1}${v.locality ? `, ${v.locality.city}` : ''}` : v.locality ? `A home in ${v.locality.city}` : 'A home';
  const bits = [v.listPriceCents === undefined || v.listPriceCents === null ? null : formatPriceCents(v.listPriceCents), v.beds === undefined || v.beds === null ? null : `${v.beds} bd`, v.bathsX10 === undefined || v.bathsX10 === null ? null : `${v.bathsX10 / 10} ba`].filter((x): x is string => x !== null);
  return `${where}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}${v.listingBrokerageName ? `. Listed by ${v.listingBrokerageName}` : ''}`;
}

function alertLines(s: SearchRow, listings: readonly { row: RawListing; mls: DisplayListing | null }[]): string {
  const homes = listings.map(({ row: l, mls }) => {
    if (mls) return mlsHomeLine(mls);
    const bits = [l.list_price_cents === null ? null : formatPriceCents(Number(l.list_price_cents)), l.beds === null ? null : `${l.beds} bd`, l.baths_x10 === null ? null : `${l.baths_x10 / 10} ba`].filter((x): x is string => x !== null);
    return `${l.address_line1}, ${l.city}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}`;
  });
  const lead = homes.length === 1 ? `A home that fits your search "${s.name}":` : `${homes.length} homes that fit your search "${s.name}":`;
  // R-MLS-2: every MLS rendering carries its pack's attribution and disclaimer (once per pack)
  const notes = [...new Set(listings.flatMap(({ mls }) => (mls ? [mls.attribution, mls.disclaimer] : [])).filter((x): x is string => x !== null))];
  return [lead, ...homes.map((h) => `- ${h}`), 'Reply here if you want to see any of them.', ...notes].join('\n');
}

/**
 * Sends the due alerts: an active search with matches not yet alerted, whose frequency window has passed
 * (instant: at once; daily / weekly). Queued as `search_alert` marketing from the system; the send-time
 * gate decides (opt-out / unsubscribe, suppression, brokerage name, autonomy switch, pause).
 */
export async function sendDueAlertsInTx(tx: Tx, deps: AssistantDeps, tenantId: string, now: Instant, o: { searchId?: string; limit?: number }): Promise<number> {
  // the frequency window is applied in the query, so searches that are not due yet never fill the batch
  // and starve the ones that are (a daily digest waiting for tomorrow is not "due")
  const nowIso = new Date(now).toISOString();
  const e = await mlsEligibility(tx, now);
  const due = await sql<RawSearch>`
    SELECT ${COLS} FROM saved_searches s WHERE s.tenant_id = app.tenant_id() AND s.status = 'active'
       AND (${o.searchId ?? null}::uuid IS NULL OR s.id = ${o.searchId ?? null}::uuid)
       AND (s.last_alerted_at IS NULL OR s.alert_frequency = 'instant'
            OR s.last_alerted_at <= ${nowIso}::timestamptz - CASE s.alert_frequency WHEN 'weekly' THEN interval '7 days' ELSE interval '1 day' END)
       AND EXISTS (SELECT 1 FROM saved_search_matches m JOIN listings l ON l.tenant_id = m.tenant_id AND l.id = m.listing_id
                    WHERE m.tenant_id = s.tenant_id AND m.search_id = s.id AND m.alerted_message_id IS NULL AND ${mlsEligibleSql(e)})
     ORDER BY s.contact_id, s.id LIMIT ${o.limit ?? 200}`.execute(tx);
  let sent = 0;
  for (const s0 of due.rows.map(row)) {
    if (s0.lastAlertedAt !== null && now - s0.lastAlertedAt < PERIOD_MS[s0.alertFrequency]) continue;
    await lockContact(tx, s0.contactId as ContactId);
    const s = await searchById(tx, s0.id, true);
    if (!s || s.status !== 'active') continue;
    const picked = await sql<RawListing & { search_id: string }>`
      SELECT ${LCOLS}, m.search_id
        FROM saved_search_matches m JOIN listings l ON l.tenant_id = m.tenant_id AND l.id = m.listing_id
       WHERE m.tenant_id = app.tenant_id() AND m.search_id = ${s.id} AND m.alerted_message_id IS NULL AND l.status IN ('active','coming_soon')
         AND ${mlsEligibleSql(e)}
       ORDER BY m.matched_at, l.id LIMIT ${ALERT_DIGEST_MAX * 5}`.execute(tx);
    // MLS rows are rendered (and re-checked) through the display rules now; one the pack withholds is not sent
    const homes = picked.rows.map((row) => ({ row, mls: row.source === 'mls' ? clientView(e, row) : null })).filter((x) => x.row.source === 'team' || x.mls !== null).slice(0, ALERT_DIGEST_MAX);
    const m = { rows: homes.map((x) => x.row) };
    if (m.rows.length === 0) continue;
    const c = await contactCore(tx, s.contactId);
    if (!c || c.deleted) continue;
    const identity = await identityFacts(tx, { scope: c.ownerUserId ? 'agent' : 'team', agentUserId: c.ownerUserId });
    const first = await firstInThread(tx, c.id);
    const lines = [`Hi ${c.firstName?.trim() || 'there'},`, alertLines(s, homes), signOffFor(identity), identity.brokerageLegalName];
    if (s.alertChannel === 'sms' && first) lines.push('Reply STOP to opt out');
    if (s.alertChannel === 'email') {
      if (identity.brokeragePostalAddress) lines.push(identity.brokeragePostalAddress);
      lines.push(EMAIL_UNSUBSCRIBE_LINE);
    }
    // the matches are re-read under the contact lock (alerted_message_id IS NULL), which is what keeps an
    // alert single; the instant keeps a re-alert after a paused search resumes distinct from the canceled one
    const key = `search-alert:${s.id}:${now}:${m.rows.map((x) => x.id).sort().join(',')}`.slice(0, 200);
    const q = await queueOutboundInTx(tx, deps, {
      contactId: c.id,
      channel: s.alertChannel,
      body: lines.join(s.alertChannel === 'sms' ? '\n' : '\n\n'),
      ...(s.alertChannel === 'email' ? { subject: m.rows.length === 1 ? 'A home that fits your search' : `${m.rows.length} homes that fit your search` } : {}),
      initiator: 'system',
      purpose: SEARCH_ALERT.purpose,
      category: SEARCH_ALERT.category,
      idempotencyKey: key,
    }, now);
    if (!q.ok) continue;
    await sql`UPDATE saved_search_matches SET alerted_message_id = ${q.messageId} WHERE tenant_id = app.tenant_id() AND search_id = ${s.id} AND listing_id = ANY (${m.rows.map((x) => x.id)}::uuid[])`.execute(tx);
    await sql`UPDATE saved_searches SET last_alerted_at = ${new Date(now).toISOString()}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${s.id}`.execute(tx);
    sent += 1;
    void tenantId;
  }
  return sent;
}

// ---- MLS compliance (module 24) ------------------------------------------------------------------------

/**
 * Cancels alerts not yet dispatched whose digest holds an MLS listing that may no longer reach a client
 * (E85 feed stale, E86 display withdrawn, R-MLS-5 now a mirror, pack un-reviewed), and releases the
 * digest's matches so the eligible homes are alerted again by the next pass. Runs as the system under each
 * contact's lock (the lock dispatch takes). Returns the canceled message ids.
 */
export async function cancelIneligibleMlsAlertsInTx(tx: Tx, now: Instant, o: { limit?: number } = {}): Promise<string[]> {
  const e = await mlsEligibility(tx, now);
  const r = await sql<RawListing & { message_id: string; contact_id: string; search_id: string }>`
    SELECT ${LCOLS}, msg.id AS message_id, msg.contact_id, x.search_id
      FROM saved_search_matches x
      JOIN messages msg ON msg.tenant_id = x.tenant_id AND msg.id = x.alerted_message_id
      JOIN listings l ON l.tenant_id = x.tenant_id AND l.id = x.listing_id
     WHERE x.tenant_id = app.tenant_id() AND l.source = 'mls' AND msg.direction = 'outbound' AND msg.status IN ('queued','scheduled')
     ORDER BY msg.contact_id, msg.id LIMIT ${o.limit ?? 500}`.execute(tx);
  const bad = new Map<string, { contactId: string; searchId: string; reason: string }>();
  for (const row of r.rows) {
    if (bad.has(row.message_id) || clientView(e, row) !== null) continue;
    const reason = row.mls_connection_id !== null && e.staleIds.includes(row.mls_connection_id) ? 'MLS_FEED_STALE' : !row.display_allowed ? 'MLS_DISPLAY_WITHDRAWN' : 'MLS_NOT_DISPLAYABLE';
    bad.set(row.message_id, { contactId: row.contact_id, searchId: row.search_id, reason });
  }
  const canceled: string[] = [];
  for (const [messageId, b] of bad) {
    await lockContact(tx, b.contactId as ContactId);
    const u = await sql<{ id: string }>`
      UPDATE messages SET status = 'canceled', status_reason = ${b.reason}
       WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
    if (u.rows.length === 0) continue; // dispatched meanwhile: the gate had the last word
    canceled.push(messageId);
    await sql`UPDATE saved_search_matches SET alerted_message_id = NULL WHERE tenant_id = app.tenant_id() AND alerted_message_id = ${messageId}`.execute(tx);
    await sql`
      UPDATE saved_searches ss SET last_alerted_at = (
        SELECT max(m.created_at) FROM saved_search_matches x JOIN messages m ON m.tenant_id = x.tenant_id AND m.id = x.alerted_message_id
         WHERE x.tenant_id = ss.tenant_id AND x.search_id = ss.id)
       WHERE ss.tenant_id = app.tenant_id() AND ss.id = ${b.searchId}`.execute(tx);
  }
  return canceled;
}
