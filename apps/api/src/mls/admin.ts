// MLS admin and the licence-pack editor (PHASE2_3_PLAN §5.4 #24; R-MLS-2, R-MLS-3, R-MLS-4; N6).
//
//   mlsAdminView       Owner/Admin: each mls_feed connection in words (status, last sync, "MLS data as of …",
//                      whether its data may reach clients now) and its licence pack, value by value.
//   saveLicensePack    Owner/Admin 🔒 (route: re-auth, CSRF): the whole pack, each value with the person's
//                      statement whether counsel reviewed it. The pack counts as counsel-reviewed
//                      (`reviewed_by_counsel_at`, read by core packReviewed) only when EVERY value is marked
//                      reviewed; otherwise nothing is shown to clients (core applyDisplayRules). A pack whose
//                      values and marks are unchanged keeps its review time; any change re-stamps it.
//                      Written under the caller's RLS (the 0018 guard lets Owner/Admin edit licence packs),
//                      audited with keys only (never the texts).
// Every value is VERIFY WITH COUNSEL / MLS; nothing here encodes a particular MLS's rules.
//
// D9 (R-CMA-6, R-CMA-7: the licence parts; E371, E372):
//   - The pack's valuation section (`license_pack.valuation`) is edited the same way with its own keys
//     (VALUATION_PACK_KEYS) and its OWN counsel stamp (`valuation.reviewed_by_counsel_at`): stamped only when every
//     valuation value is marked reviewed, kept when values and marks are unchanged, re-stamped on any change. The
//     display pack's stamp never depends on it, so adding the section never changes an existing pack's review state
//     (E371). The PUT body's `valuation` is optional: when omitted the stored section is kept byte for byte, so
//     module 41's editor, which sends the nine display keys, keeps working. Audited with keys only, never statement
//     texts.
//   - Sold-data coverage (E372, V2): over the newest 5,000 sold MLS rows per connection by modification time
//     (listings_mls_connection_idx), the count, the oldest close date and the share of rows carrying each sale fact,
//     plus the "Filling sold history" sentence while a backfill is pending on a connection the sync reads (live, and
//     not Spark with MLS_LIVE_CALLS false; otherwise it says nothing is read). Counts and shares only: no confidence
//     and no score.
import { DISPLAY_FIELDS, type DisplayField, LISTING_STATUSES, type ListingStatus, USPS_REGIONS, feedStale, packReviewed, parseLicensePack, staleNotice } from '@realty/core/listings';
import type { IanaZone, Instant, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { serviceOf, statusSentence } from '../integrations/catalog.js';
import type { ConnectionStatus } from '../providers/integrations/types.js';
import { RESULT_SENTENCE } from './spark/service.js';
import { connectionClientEligible, mlsConnections } from './eligibility.js';

/** The editable values, in display order (snake_case: the stored JSON keys). */
export const PACK_KEYS = ['max_staleness_hours', 'attribution_text', 'disclaimer_text', 'allow_rehost_photos', 'require_listing_brokerage', 'client_fields', 'client_statuses', 'public_fields', 'public_statuses'] as const;
export type PackKey = (typeof PACK_KEYS)[number];

export interface PackValues {
  max_staleness_hours: number | null;
  attribution_text: string | null;
  disclaimer_text: string | null;
  allow_rehost_photos: boolean;
  require_listing_brokerage: boolean;
  client_fields: DisplayField[];
  client_statuses: ListingStatus[];
  public_fields: DisplayField[];
  public_statuses: ListingStatus[];
}

export type PackInput = { [K in PackKey]: { value: PackValues[K]; counselReviewed: boolean } };

/** The valuation section's editable values (D9), in display order (snake_case: the stored JSON keys). */
export const VALUATION_PACK_KEYS = ['agent_cma', 'client_cma', 'automated_notes', 'avm_flag_scope', 'statements'] as const;
export type ValuationPackKey = (typeof VALUATION_PACK_KEYS)[number];

export interface ValuationStatementValue {
  /** USPS code */
  region: string;
  text: string;
  minPointSize: number;
}

export interface ValuationPackValues {
  agent_cma: boolean;
  client_cma: boolean;
  automated_notes: boolean;
  avm_flag_scope: 'all_client_outputs' | 'internet_display_only';
  statements: ValuationStatementValue[];
}

export type ValuationPackInput = { [K in ValuationPackKey]: { value: ValuationPackValues[K]; counselReviewed: boolean } };

export interface ValuationPackView {
  values: { key: ValuationPackKey; value: ValuationPackValues[ValuationPackKey]; counselReviewed: boolean }[];
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
}

export interface PackView {
  values: { key: PackKey; value: PackValues[PackKey]; counselReviewed: boolean }[];
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
  valuation: ValuationPackView;
}

/** Sold-data coverage of one connection (E372; V2: the real fill rates). Shares are whole percents of `rows`. */
export interface SoldCoverage {
  /** rows read: the newest sold MLS rows by modification time, at most SOLD_COVERAGE_SAMPLE */
  rows: number;
  sampleLimit: number;
  oldestCloseDate: string | null;
  shares: Record<'closePrice' | 'closeDate' | 'contractDate' | 'location' | 'yearBuilt' | 'lotSize' | 'subdivision' | 'saleConditions' | 'avmDisplayAllowed', number>;
  backfillPending: boolean;
  sentence: string;
}

export const SOLD_COVERAGE_SAMPLE = 5000;
export const FILLING_SENTENCE = 'Filling sold history from the MLS. Coverage grows as older records are re-read.';
/** Whether the sync reads this connection now (it claims connected or degraded rows; feeds.ts refuses Spark with live calls off). */
export interface SoldRead {
  live: boolean;
  liveCallsOff: boolean;
}
const NOT_LIVE_SENTENCE = 'The connection is not live, so no sold history is read from the MLS.';
const LIVE_CALLS_OFF_SENTENCE = 'Live MLS calls are turned off on this deployment, so no sold history is read from the MLS.';

export interface MlsConnectionAdminView {
  id: string;
  displayName: string;
  status: string;
  statusSentence: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  mlsDataAsOf: string;
  feedStale: boolean;
  clientDisplay: boolean;
  clientDisplaySentence: string;
  licensePack: PackView;
  soldData: SoldCoverage;
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** The stored JSON → the editor's values (strictest where unreadable, like core parseLicensePack). */
export function packValues(stored: unknown): { values: PackValues; marks: Partial<Record<PackKey, boolean>> } {
  const p = parseLicensePack(stored);
  const marksRaw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>)['counsel_reviewed_values'] : undefined;
  const marks: Partial<Record<PackKey, boolean>> = {};
  if (marksRaw && typeof marksRaw === 'object' && !Array.isArray(marksRaw)) for (const k of PACK_KEYS) if ((marksRaw as Record<string, unknown>)[k] === true) marks[k] = true;
  return {
    values: {
      max_staleness_hours: p.maxStalenessHours,
      attribution_text: p.attributionText,
      disclaimer_text: p.disclaimerText,
      allow_rehost_photos: p.allowRehostPhotos,
      require_listing_brokerage: p.requireListingBrokerage,
      client_fields: [...p.audiences.client.fields],
      client_statuses: [...p.audiences.client.statuses],
      public_fields: [...p.audiences.public.fields],
      public_statuses: [...p.audiences.public.statuses],
    },
    marks,
  };
}

const storedSection = (stored: unknown): unknown => (stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>)['valuation'] : undefined);

/** The stored valuation section → the editor's values (strictest where unreadable, like core parseLicensePack). */
export function valuationValues(stored: unknown): { values: ValuationPackValues; marks: Partial<Record<ValuationPackKey, boolean>> } {
  const v = parseLicensePack(stored).valuation;
  const section = storedSection(stored);
  const marksRaw = section && typeof section === 'object' && !Array.isArray(section) ? (section as Record<string, unknown>)['counsel_reviewed_values'] : undefined;
  const marks: Partial<Record<ValuationPackKey, boolean>> = {};
  if (marksRaw && typeof marksRaw === 'object' && !Array.isArray(marksRaw)) for (const k of VALUATION_PACK_KEYS) if ((marksRaw as Record<string, unknown>)[k] === true) marks[k] = true;
  return {
    values: {
      agent_cma: v.agentCma,
      client_cma: v.clientCma,
      automated_notes: v.automatedNotes,
      avm_flag_scope: v.avmFlagScope,
      statements: Object.entries(v.statements).map(([region, st]) => ({ region, text: st.text, minPointSize: st.minPointSize })),
    },
    marks,
  };
}

/**
 * D9: nothing built from MLS sales reaches a client in V1, whatever the valuation section says (sharing is V2's; client
 * CMAs and seller value ranges also wait on platform:cma, which ships unreviewed). Said on every valuation view, so a
 * fully marked section never reads as turning client values on (batch 10 review gates/F6, api-ui/F7).
 */
export const VALUATION_NO_SHARING = 'Nothing built from MLS sales reaches a client in this version: client CMAs are not built yet, and they would also wait for counsel review of the in-house CMA wording (platform:cma) on the Integrations page.';

/**
 * The section in words: what agents may do (valuation.agent_cma alone admits an agent CMA, R-CMA-6: the Owner/Admin's
 * statement, no counsel stamp needed), how much counsel review is marked, and VALUATION_NO_SHARING.
 */
export function valuationPackView(stored: unknown): ValuationPackView {
  const { values, marks } = valuationValues(stored);
  const v = parseLicensePack(stored).valuation;
  const unreviewed = VALUATION_PACK_KEYS.filter((k) => marks[k] !== true).length;
  const agent = values.agent_cma
    ? 'Agents may prepare CMAs from the MLS sales of this connection while it is live, for their own use.'
    : 'Agent CMAs need an Owner or Admin to record, from your MLS agreement, that sold data may be used for valuations: Valuation use, on the MLS admin page.';
  const review = v.reviewedByCounselAt !== null ? 'Every valuation value is marked as reviewed by counsel.' : `${unreviewed} of ${VALUATION_PACK_KEYS.length} valuation values are not marked as reviewed by counsel.`;
  const sentence = `${agent} ${review} ${VALUATION_NO_SHARING}`;
  return { values: VALUATION_PACK_KEYS.map((key) => ({ key, value: values[key], counselReviewed: marks[key] === true })), reviewedByCounselAt: v.reviewedByCounselAt, unreviewedCount: unreviewed, sentence };
}

export function packView(stored: unknown): PackView {
  const { values, marks } = packValues(stored);
  const pack = parseLicensePack(stored);
  const unreviewed = PACK_KEYS.filter((k) => marks[k] !== true).length;
  const sentence = packReviewed(pack)
    ? 'Every value is marked as reviewed by counsel. MLS listings may be shown to clients within these rules.'
    : `Not shown to clients: ${unreviewed} of ${PACK_KEYS.length} values are not marked as reviewed by counsel.`;
  return { values: PACK_KEYS.map((key) => ({ key, value: values[key], counselReviewed: marks[key] === true })), reviewedByCounselAt: pack.reviewedByCounselAt, unreviewedCount: unreviewed, sentence, valuation: valuationPackView(stored) };
}

/** The stored valuation section for an input (statements keyed by USPS code; unknown codes dropped, never widened). */
export function storedValuation(input: ValuationPackInput, reviewedAt: string | null): Record<string, unknown> {
  const statements: Record<string, { text: string; min_point_size: number }> = {};
  for (const st of input.statements.value) if (Object.hasOwn(USPS_REGIONS, st.region)) statements[st.region] = { text: st.text, min_point_size: st.minPointSize };
  const ordered = Object.fromEntries(Object.keys(USPS_REGIONS).filter((c) => c in statements).map((c) => [c, statements[c]]));
  return {
    agent_cma: input.agent_cma.value,
    client_cma: input.client_cma.value,
    automated_notes: input.automated_notes.value,
    avm_flag_scope: input.avm_flag_scope.value,
    statements: ordered,
    reviewed_by_counsel_at: reviewedAt,
    counsel_reviewed_values: Object.fromEntries(VALUATION_PACK_KEYS.map((k) => [k, input[k].counselReviewed === true])),
  };
}

/** The JSON stored for an input (canonical order; unknown fields and statuses dropped, never widened). */
export function storedPack(input: PackInput, reviewedAt: string | null): Record<string, unknown> {
  const fields = (xs: readonly string[]) => DISPLAY_FIELDS.filter((f) => xs.includes(f));
  const statuses = (xs: readonly string[]) => LISTING_STATUSES.filter((s) => xs.includes(s));
  return {
    reviewed_by_counsel_at: reviewedAt,
    max_staleness_hours: input.max_staleness_hours.value,
    attribution_text: input.attribution_text.value,
    disclaimer_text: input.disclaimer_text.value,
    allow_rehost_photos: input.allow_rehost_photos.value,
    require_listing_brokerage: input.require_listing_brokerage.value,
    audiences: {
      client: { fields: fields(input.client_fields.value), statuses: statuses(input.client_statuses.value) },
      public: { fields: fields(input.public_fields.value), statuses: statuses(input.public_statuses.value) },
    },
    counsel_reviewed_values: Object.fromEntries(PACK_KEYS.map((k) => [k, input[k].counselReviewed === true])),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type ConnRow = { id: string; display_name: string; status: ConnectionStatus; status_reason: string | null; last_error_code: string | null; disconnected_at: Date | null; last_synced_at: Date | null; next_sync_at: Date | null; license_pack: unknown; mls_backfill_pending: boolean };

/**
 * E372: coverage of one connection's sold rows (see the header). Under the caller's RLS. "Filling" only while the
 * connection is read (batch 10 review api-ui/F6): 0068 set the backfill flag on every mls_feed row, whatever its status,
 * and the sync reads only live rows, never a Spark row while MLS_LIVE_CALLS is false.
 */
export async function soldCoverage(tx: Tx, connectionId: string, backfillPending: boolean, read: SoldRead = { live: true, liveCallsOff: false }): Promise<SoldCoverage> {
  const r = await sql<Record<'n' | 'close_price' | 'close_date' | 'contract_date' | 'location' | 'year_built' | 'lot_size' | 'subdivision' | 'sale_conditions' | 'avm', number> & { oldest: string | null }>`
    SELECT count(*)::int AS n, min(s.close_date)::text AS oldest,
           count(s.close_price_cents)::int AS close_price, count(s.close_date)::int AS close_date, count(s.purchase_contract_date)::int AS contract_date,
           count(s.latitude_e6)::int AS location, count(s.year_built)::int AS year_built, count(s.lot_sqft)::int AS lot_size,
           count(s.subdivision_name)::int AS subdivision, count(*) FILTER (WHERE cardinality(s.sale_conditions) > 0)::int AS sale_conditions,
           count(*) FILTER (WHERE s.avm_display_allowed)::int AS avm
      FROM (SELECT l.close_price_cents, l.close_date, l.purchase_contract_date, l.latitude_e6, l.year_built, l.lot_sqft, l.subdivision_name, l.sale_conditions, l.avm_display_allowed
              FROM listings l
             WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.mls_connection_id = ${connectionId} AND l.status = 'sold'
             ORDER BY l.mls_modified_at DESC LIMIT ${SOLD_COVERAGE_SAMPLE}) s`.execute(tx);
  const x = r.rows[0]!;
  const pct = (k: number) => (x.n === 0 ? 0 : Math.round((100 * k) / x.n));
  const counts =
    x.n === 0
      ? 'No sold MLS records yet.'
      : `${x.n.toLocaleString('en-US')} recent sold MLS records${x.n >= SOLD_COVERAGE_SAMPLE ? ' (the newest 5,000)' : ''}; ${pct(x.close_price)}% carry a close price and ${pct(x.location)}% a location.`;
  const sentence = read.liveCallsOff ? `${LIVE_CALLS_OFF_SENTENCE} ${counts}` : !read.live ? `${NOT_LIVE_SENTENCE} ${counts}` : backfillPending ? FILLING_SENTENCE : counts;
  return {
    rows: x.n,
    sampleLimit: SOLD_COVERAGE_SAMPLE,
    oldestCloseDate: x.oldest,
    shares: { closePrice: pct(x.close_price), closeDate: pct(x.close_date), contractDate: pct(x.contract_date), location: pct(x.location), yearBuilt: pct(x.year_built), lotSize: pct(x.lot_size), subdivision: pct(x.subdivision), saleConditions: pct(x.sale_conditions), avmDisplayAllowed: pct(x.avm) },
    backfillPending,
    sentence,
  };
}

async function mlsRows(tx: Tx, id?: string, lock = false): Promise<ConnRow[]> {
  return (
    await sql<ConnRow>`
      SELECT id, display_name, status, status_reason, last_error_code, disconnected_at, last_synced_at, next_sync_at, license_pack, mls_backfill_pending FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed' AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
       ORDER BY created_at, id ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx)
  ).rows;
}

/** The deployment's MLS settings this view needs (config.mls): Spark with live calls off reads nothing. */
export type MlsDeploymentFacts = { provider: 'fake' | 'spark'; liveCalls: boolean };

export async function mlsAdminView(tx: Tx, now: Instant, mls: MlsDeploymentFacts = { provider: 'fake', liveCalls: false }): Promise<{ connections: MlsConnectionAdminView[] }> {
  const zone = ((await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC') as IanaZone;
  const facts = new Map((await mlsConnections(tx)).map((c) => [c.id, c]));
  const rows = await mlsRows(tx);
  const coverage = new Map<string, SoldCoverage>();
  const liveCallsOff = mls.provider === 'spark' && !mls.liveCalls;
  for (const r of rows) coverage.set(r.id, await soldCoverage(tx, r.id, r.mls_backfill_pending, { live: r.status === 'connected' || r.status === 'degraded', liveCallsOff }));
  return {
    connections: rows.map((r) => {
      const f = facts.get(r.id)!;
      const stale = feedStale(f.lastSyncedAt, now, f.pack);
      const eligible = connectionClientEligible(f, now);
      const base = statusSentence(r.status, r.status_reason, serviceOf('mls_feed')!, { disconnectedAt: isoOrNull(r.disconnected_at) });
      const hint = r.last_error_code ? RESULT_SENTENCE[r.last_error_code] : undefined;
      return {
        id: r.id,
        displayName: r.display_name,
        status: r.status,
        statusSentence: hint ? `${base} ${hint}` : base,
        lastSyncedAt: isoOrNull(r.last_synced_at),
        nextSyncAt: isoOrNull(r.next_sync_at),
        mlsDataAsOf: staleNotice(f.lastSyncedAt, zone),
        feedStale: stale,
        clientDisplay: eligible,
        clientDisplaySentence: eligible
          ? 'MLS listings may reach clients (alerts) within the licence pack.'
          : !packReviewed(f.pack)
            ? 'MLS listings are not shown to clients: the licence pack is not counsel-reviewed.'
            : f.pack.attributionText === null || f.pack.disclaimerText === null
              ? 'MLS listings are not shown to clients: the licence pack needs an attribution and a disclaimer.'
              : stale
                ? 'MLS listings are paused for clients: the MLS data is older than the licence pack allows.'
                : 'MLS listings are not shown to clients: the connection is not live.',
        licensePack: packView(r.license_pack),
        soldData: coverage.get(r.id)!,
      };
    }),
  };
}

export async function saveLicensePack(tx: Tx, actor: UserActor, connectionId: string, input: PackInput & { valuation?: ValuationPackInput }, now: Instant): Promise<PackView> {
  const [row] = await mlsRows(tx, connectionId, true);
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status === 'disconnected') throw new AppError('CONNECTION_NOT_CONNECTABLE', { status: row.status });
  const before = packValues(row.license_pack);
  const allReviewed = PACK_KEYS.every((k) => input[k].counselReviewed === true);
  const prevAt = parseLicensePack(row.license_pack).reviewedByCounselAt;
  const unchanged = sameJson(storedPack(input, null), storedPack(Object.fromEntries(PACK_KEYS.map((k) => [k, { value: before.values[k], counselReviewed: before.marks[k] === true }])) as PackInput, null));
  const reviewedAt = allReviewed ? (unchanged && prevAt ? prevAt : new Date(now).toISOString()) : null;
  const next: Record<string, unknown> = storedPack(input, reviewedAt);
  // the valuation section (D9): its own stamp; omitted ⇒ the stored section is kept unchanged
  const storedVal = storedSection(row.license_pack);
  const beforeVal = valuationValues(row.license_pack);
  const valReviewedBefore = parseLicensePack(row.license_pack).valuation.reviewedByCounselAt;
  let valReviewedAfter = valReviewedBefore;
  let valuationChanged: string[] = [];
  if (input.valuation) {
    const vin = input.valuation;
    const allVal = VALUATION_PACK_KEYS.every((k) => vin[k].counselReviewed === true);
    const prevInput = Object.fromEntries(VALUATION_PACK_KEYS.map((k) => [k, { value: beforeVal.values[k], counselReviewed: beforeVal.marks[k] === true }])) as ValuationPackInput;
    const sameVal = sameJson(storedValuation(vin, null), storedValuation(prevInput, null));
    valReviewedAfter = allVal ? (sameVal && valReviewedBefore ? valReviewedBefore : new Date(now).toISOString()) : null;
    next['valuation'] = storedValuation(vin, valReviewedAfter);
    const afterVal = valuationValues(next).values;
    valuationChanged = VALUATION_PACK_KEYS.filter((k) => !sameJson(beforeVal.values[k], afterVal[k])).map((k) => `valuation.${k}`);
  } else if (storedVal !== undefined) {
    next['valuation'] = storedVal; // kept unchanged (module 41's editor sends the display keys only)
  }
  await sql`UPDATE integration_connections SET license_pack = ${JSON.stringify(next)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${row.id}`.execute(tx);
  const after = packValues(next).values;
  const changedKeys = [...PACK_KEYS.filter((k) => !sameJson(before.values[k], after[k])), ...valuationChanged];
  await audit(tx, actor, {
    action: 'integration.changed',
    entity: { type: 'integration_connection', id: row.id },
    changes: redactDiff(
      { license_pack_reviewed: prevAt !== null, valuation_reviewed: valReviewedBefore !== null },
      {
        license_pack_reviewed: reviewedAt !== null,
        valuation_reviewed: valReviewedAfter !== null,
        changed_keys: changedKeys.join(','),
        unreviewed_keys: [...PACK_KEYS.filter((k) => !input[k].counselReviewed), ...(input.valuation ? VALUATION_PACK_KEYS.filter((k) => !input.valuation![k].counselReviewed).map((k) => `valuation.${k}`) : [])].join(','),
      },
    ),
    reason: 'LICENSE_PACK_CHANGED',
  });
  return packView(next);
}
