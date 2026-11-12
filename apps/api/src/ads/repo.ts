// SQL of api/ads (module 52). Every statement runs in the caller's transaction, under its RLS: a person (Owner/Admin),
// or the system actor of one tenant. This file is the ONLY writer of `lead_source_costs` rows with origin 'ads_sync'
// (R-ADS-11, R-OWNER-5; ads/architecture.test.ts), and with ads/dispatch.ts and ads/mirror.ts the only code that
// writes ad_campaigns and ad_allocation_events (through the functions below).
//
// Money is integer cents; bigint columns are read back as numbers (every amount is a safe integer, core/ads checks).
import type { Campaign, CampaignId, CampaignStatus, CapVersionId, ConnectionStatus, LedgerEventKind, MarketingPieceId } from '@realty/core/ads';
import type { IdGenerator, ListingId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { ADS_KIND, ADS_PACK } from './settings.js';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---- the pack -------------------------------------------------------------------------------------------------------

export async function packCleared(tx: Tx): Promise<boolean> {
  const r = await sql<{ c: boolean }>`SELECT app.platform_cleared(${ADS_PACK}, true) AS c`.execute(tx);
  return r.rows[0]?.c === true;
}

export interface PackRow {
  key: string;
  version: string;
  reviewedByCounselAt: string | null;
  vendorReadyAt: string | null;
}

export async function packRow(tx: Tx): Promise<PackRow | null> {
  const r = await sql<{ key: string; version: string; reviewed_by_counsel_at: Date | null; vendor_ready_at: string | null }>`
    SELECT key, version, reviewed_by_counsel_at, rules->>'vendor_ready_at' AS vendor_ready_at
      FROM jurisdiction_packs WHERE key = ${ADS_PACK} AND status = 'published' ORDER BY version DESC LIMIT 1`.execute(tx);
  const p = r.rows[0];
  return p ? { key: p.key, version: p.version, reviewedByCounselAt: iso(p.reviewed_by_counsel_at), vendorReadyAt: p.vendor_ready_at } : null;
}

// ---- connections ----------------------------------------------------------------------------------------------------

/** What the last successful pass learned about the account and each campaign (kept in sync_cursor, JSON). */
export interface SyncSnapshot {
  v: 1;
  /** the pass's instant (ISO) */
  at: string;
  currency: string;
  zone: string;
  /** externalCampaignId → the facts the overview explains from (the ad_campaigns row has no column for them) */
  campaigns: Record<string, { budget: 'own' | 'shared' | 'not_reported'; housing: 'declared' | 'not_declared' | 'unknown'; issue: string | null }>;
}

export interface AdsConnection {
  id: string;
  status: ConnectionStatus;
  statusReason: string | null;
  externalAccountId: string | null;
  credentialId: string | null;
  leadSourceId: string | null;
  lastSyncedAt: string | null;
  connectedAt: string | null;
  lastErrorCode: string | null;
  snapshot: SyncSnapshot | null;
}

function parseSnapshot(s: string | null): SyncSnapshot | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as SyncSnapshot;
    return v && v.v === 1 && typeof v.zone === 'string' && typeof v.currency === 'string' && v.campaigns && typeof v.campaigns === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Every ads_google connection of the tenant that is not disconnected, oldest first; with `withDisconnected`, the
 * disconnected ones too (only the reconcile's "not checked" alert reads them, E454).
 */
export async function adsConnections(tx: Tx, o: { forUpdate?: boolean; withDisconnected?: boolean } = {}): Promise<AdsConnection[]> {
  const lock = o.forUpdate ? sql` FOR UPDATE` : sql``;
  const live = o.withDisconnected ? sql`` : sql` AND status <> 'disconnected'`;
  const r = await sql<{
    id: string; status: ConnectionStatus; status_reason: string | null; external_account_id: string | null; credential_id: string | null; lead_source_id: string | null;
    last_synced_at: Date | null; connected_at: Date | null; last_error_code: string | null; sync_cursor: string | null;
  }>`
    SELECT id, status, status_reason, external_account_id, credential_id, lead_source_id, last_synced_at, connected_at, last_error_code, sync_cursor
      FROM integration_connections
     WHERE tenant_id = app.tenant_id() AND kind = ${ADS_KIND}${live}
     ORDER BY created_at, id${lock}`.execute(tx);
  return r.rows.map((c) => ({
    id: c.id, status: c.status, statusReason: c.status_reason, externalAccountId: c.external_account_id, credentialId: c.credential_id,
    leadSourceId: c.lead_source_id, lastSyncedAt: iso(c.last_synced_at), connectedAt: iso(c.connected_at), lastErrorCode: c.last_error_code, snapshot: parseSnapshot(c.sync_cursor),
  }));
}

/**
 * The health and sync state the system records after a pass (R-INT-2): status through module 21's status machine
 * (the caller passes its result), the error code, and on a successful spend check the sync time and the snapshot.
 * It never writes the routing key, the credential or the reported capabilities (module 21's callback does).
 */
export async function recordConnectionSync(
  tx: Tx,
  id: string,
  p: { status: ConnectionStatus; statusReason: string | null; lastErrorCode: string | null; synced?: { at: string; snapshot: SyncSnapshot } },
): Promise<void> {
  if (p.synced) {
    await sql`UPDATE integration_connections SET status = ${p.status}, status_reason = ${p.statusReason}, last_error_code = ${p.lastErrorCode},
                     last_synced_at = ${p.synced.at}::timestamptz, sync_cursor = ${JSON.stringify(p.synced.snapshot)}
               WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  } else {
    await sql`UPDATE integration_connections SET status = ${p.status}, status_reason = ${p.statusReason}, last_error_code = ${p.lastErrorCode}
               WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  }
}

/** The connection's decrypted access token (R-INT-4: decrypted in a short transaction as the system), or null. */
export async function credentialCipher(tx: Tx, credentialId: string): Promise<Buffer | null> {
  const r = await sql<{ secret_enc: Buffer | null; status: string }>`
    SELECT secret_enc, status FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId}::uuid`.execute(tx);
  const c = r.rows[0];
  return c && c.status === 'active' && c.secret_enc ? c.secret_enc : null;
}

// ---- caps -----------------------------------------------------------------------------------------------------------

export interface CapRow {
  id: CapVersionId;
  versionNo: number;
  monthlyCapCents: number;
  dailyCeilingCents: number;
  effectiveFrom: string;
}

/** The cap version in force, ordered exactly as app.ad_allocation_cap_check() orders it (0018). */
export async function capInForce(tx: Tx): Promise<CapRow | null> {
  const r = await sql<{ id: string; version_no: number; monthly_cap_cents: string; daily_ceiling_cents: string; effective_from: Date }>`
    SELECT id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from FROM ad_budget_caps
     WHERE tenant_id = app.tenant_id() AND effective_from <= now()
     ORDER BY effective_from DESC, version_no DESC LIMIT 1`.execute(tx);
  const c = r.rows[0];
  return c ? { id: c.id as CapVersionId, versionNo: c.version_no, monthlyCapCents: n(c.monthly_cap_cents), dailyCeilingCents: n(c.daily_ceiling_cents), effectiveFrom: c.effective_from.toISOString() } : null;
}

export async function nextCapVersionNo(tx: Tx): Promise<number> {
  const r = await sql<{ v: number | null }>`SELECT max(version_no) AS v FROM ad_budget_caps WHERE tenant_id = app.tenant_id()`.execute(tx);
  return (r.rows[0]?.v ?? 0) + 1;
}

export async function insertCap(tx: Tx, c: { id: string; versionNo: number; monthlyCapCents: number; dailyCeilingCents: number; userId: string; attestation: string }): Promise<void> {
  await sql`INSERT INTO ad_budget_caps (tenant_id, id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from, approved_by_user_id, attestation)
            VALUES (app.tenant_id(), ${c.id}::uuid, ${c.versionNo}, ${c.monthlyCapCents}, ${c.dailyCeilingCents}, now(), ${c.userId}::uuid, ${c.attestation})`.execute(tx);
}

// ---- campaigns ------------------------------------------------------------------------------------------------------

export interface CampaignRow {
  id: string;
  connectionId: string;
  connectionKind: string;
  connectionStatus: ConnectionStatus;
  externalCampaignId: string;
  name: string;
  leadSourceId: string;
  campaignRef: string;
  listingId: string | null;
  creativePieceId: string | null;
  creativeStatus: string | null;
  creativeListingId: string | null;
  specialCategory: string;
  targeting: unknown;
  status: CampaignStatus;
  dailyBudgetCents: number;
  latestEvent: { id: string; kind: LedgerEventKind; toDailyCents: number; runId: string; occurredAt: string } | null;
}

/** Every campaign the caller sees, with its connection, creative and latest ledger event (by occurred_at, then id). */
export async function campaignRows(tx: Tx, o: { ids?: readonly string[]; forUpdate?: boolean } = {}): Promise<CampaignRow[]> {
  const only = o.ids ? sql` AND c.id = ANY(${[...o.ids]}::uuid[])` : sql``;
  const lock = o.forUpdate ? sql` FOR UPDATE OF c` : sql``;
  const r = await sql<{
    id: string; connection_id: string; kind: string; conn_status: ConnectionStatus; external_campaign_id: string; name: string; lead_source_id: string; campaign_ref: string;
    listing_id: string | null; creative_piece_id: string | null; creative_status: string | null; creative_listing_id: string | null; special_category: string;
    targeting: unknown; status: CampaignStatus; daily_budget_cents: string;
  }>`
    SELECT c.id, c.connection_id, ic.kind, ic.status AS conn_status, c.external_campaign_id, c.name, c.lead_source_id, c.campaign_ref, c.listing_id,
           c.creative_piece_id, mp.status AS creative_status, mp.listing_id AS creative_listing_id, c.special_category, c.targeting, c.status, c.daily_budget_cents
      FROM ad_campaigns c
      JOIN integration_connections ic ON ic.tenant_id = c.tenant_id AND ic.id = c.connection_id
      LEFT JOIN marketing_pieces mp ON mp.tenant_id = c.tenant_id AND mp.id = c.creative_piece_id
     WHERE c.tenant_id = app.tenant_id()${only}
     ORDER BY c.id${lock}`.execute(tx);
  const latest = await latestEvents(tx, r.rows.map((x) => x.id));
  return r.rows.map((x) => ({
    id: x.id, connectionId: x.connection_id, connectionKind: x.kind, connectionStatus: x.conn_status, externalCampaignId: x.external_campaign_id, name: x.name,
    leadSourceId: x.lead_source_id, campaignRef: x.campaign_ref, listingId: x.listing_id, creativePieceId: x.creative_piece_id, creativeStatus: x.creative_status,
    creativeListingId: x.creative_listing_id, specialCategory: x.special_category, targeting: x.targeting, status: x.status, dailyBudgetCents: n(x.daily_budget_cents),
    latestEvent: latest.get(x.id) ?? null,
  }));
}

async function latestEvents(tx: Tx, ids: readonly string[]): Promise<Map<string, NonNullable<CampaignRow['latestEvent']>>> {
  if (ids.length === 0) return new Map();
  const r = await sql<{ campaign_id: string; id: string; event_kind: LedgerEventKind; to_daily_cents: string; run_id: string; occurred_at: Date }>`
    SELECT DISTINCT ON (campaign_id) campaign_id, id, event_kind, to_daily_cents, run_id, occurred_at FROM ad_allocation_events
     WHERE tenant_id = app.tenant_id() AND campaign_id = ANY(${[...ids]}::uuid[])
     ORDER BY campaign_id, occurred_at DESC, id DESC`.execute(tx);
  return new Map(r.rows.map((e) => [e.campaign_id, { id: e.id, kind: e.event_kind, toDailyCents: n(e.to_daily_cents), runId: e.run_id, occurredAt: e.occurred_at.toISOString() }]));
}

/** A campaign row in core's shape (core/ads Campaign). */
export function toCoreCampaign(r: CampaignRow): Campaign {
  return {
    id: r.id as CampaignId,
    connectionKind: r.connectionKind,
    connectionStatus: r.connectionStatus,
    status: r.status,
    specialCategory: r.specialCategory,
    targeting: r.targeting,
    listingId: r.listingId as ListingId | null,
    creative:
      r.creativePieceId !== null && r.creativeStatus !== null && r.creativeListingId !== null
        ? { pieceId: r.creativePieceId as MarketingPieceId, status: r.creativeStatus as never, listingId: r.creativeListingId as ListingId }
        : null,
    dailyBudgetCents: r.dailyBudgetCents,
    latestEvent: r.latestEvent ? { kind: r.latestEvent.kind, toDailyCents: r.latestEvent.toDailyCents } : null,
  };
}

/** Whether `pieceId` is an approved or published piece of `listingId` (as the caller sees it). */
export async function creativeApprovedFor(tx: Tx, pieceId: string, listingId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND id = ${pieceId}::uuid AND listing_id = ${listingId}::uuid
                    AND status IN ('approved','published')) AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

/** The mirror's insert of a campaign it has not seen (system; budget through the system only, R-ADS-3). */
export async function insertCampaign(
  tx: Tx,
  c: { id: string; connectionId: string; externalCampaignId: string; name: string; leadSourceId: string; campaignRef: string; targeting: unknown; status: CampaignStatus; dailyBudgetCents: number },
): Promise<void> {
  await sql`INSERT INTO ad_campaigns (tenant_id, id, connection_id, external_campaign_id, name, lead_source_id, campaign_ref, targeting, status, daily_budget_cents)
            VALUES (app.tenant_id(), ${c.id}::uuid, ${c.connectionId}::uuid, ${c.externalCampaignId}, ${c.name}, ${c.leadSourceId}::uuid, ${c.campaignRef},
                    ${JSON.stringify(c.targeting)}::jsonb, ${c.status}, ${c.dailyBudgetCents})`.execute(tx);
}

/** The mirror's update of what the platform reports (system): name, targeting, status and budget. */
export async function updateMirroredCampaign(tx: Tx, id: string, p: { name: string; targeting: unknown; status: CampaignStatus; dailyBudgetCents: number }): Promise<void> {
  await sql`UPDATE ad_campaigns SET name = ${p.name}, targeting = ${JSON.stringify(p.targeting)}::jsonb, status = ${p.status}, daily_budget_cents = ${p.dailyBudgetCents}
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid
               AND (name, targeting, status, daily_budget_cents) IS DISTINCT FROM (${p.name}, ${JSON.stringify(p.targeting)}::jsonb, ${p.status}, ${p.dailyBudgetCents}::bigint)`.execute(tx);
}

/** The mirror after an applied ledger change (system): the budget, and the status only when given. */
export async function mirrorBudget(tx: Tx, id: string, dailyBudgetCents: number, status?: CampaignStatus): Promise<void> {
  if (status === undefined) {
    await sql`UPDATE ad_campaigns SET daily_budget_cents = ${dailyBudgetCents} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  } else {
    await sql`UPDATE ad_campaigns SET daily_budget_cents = ${dailyBudgetCents}, status = ${status} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  }
}

export async function setCampaignStatus(tx: Tx, id: string, status: CampaignStatus): Promise<void> {
  await sql`UPDATE ad_campaigns SET status = ${status} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** A person's link of a campaign to a listing and its creative (Owner/Admin, as themselves; only these two ids). */
export async function linkCampaign(tx: Tx, id: string, listingId: string, creativePieceId: string): Promise<boolean> {
  const r = await sql`UPDATE ad_campaigns SET listing_id = ${listingId}::uuid, creative_piece_id = ${creativePieceId}::uuid
                       WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

// ---- the ledger -----------------------------------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  runId: string;
  campaignId: string;
  eventKind: LedgerEventKind;
  capVersionId: string;
  assistantActionId: string | null;
  fromDailyCents: number;
  toDailyCents: number;
  reasonCode: string;
  providerRef: string | null;
  occurredAt: string;
}

type LedgerDb = {
  id: string; run_id: string; campaign_id: string; event_kind: LedgerEventKind; cap_version_id: string; assistant_action_id: string | null;
  from_daily_cents: string; to_daily_cents: string; reason_code: string; provider_ref: string | null; occurred_at: Date;
};
const ledger = (e: LedgerDb): LedgerRow => ({
  id: e.id, runId: e.run_id, campaignId: e.campaign_id, eventKind: e.event_kind, capVersionId: e.cap_version_id, assistantActionId: e.assistant_action_id,
  fromDailyCents: n(e.from_daily_cents), toDailyCents: n(e.to_daily_cents), reasonCode: e.reason_code, providerRef: e.provider_ref, occurredAt: e.occurred_at.toISOString(),
});

/** Inserts one ledger row; occurred_at is the DB clock of the transaction (so planned < applied across transactions). */
export async function insertEvent(
  tx: Tx,
  e: { id: string; runId: string; campaignId: string; kind: LedgerEventKind; capVersionId: string; actionId: string | null; fromDailyCents: number; toDailyCents: number; reasonCode: string; providerRef: string | null },
): Promise<void> {
  await sql`INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, assistant_action_id, from_daily_cents, to_daily_cents,
                                              reason_code, provider_ref, occurred_at)
            VALUES (app.tenant_id(), ${e.id}::uuid, ${e.runId}::uuid, ${e.campaignId}::uuid, ${e.kind}, ${e.capVersionId}::uuid, ${e.actionId}::uuid,
                    ${e.fromDailyCents}, ${e.toDailyCents}, ${e.reasonCode}, ${e.providerRef}, now())`.execute(tx);
}

export async function runEvents(tx: Tx, runId: string): Promise<LedgerRow[]> {
  const r = await sql<LedgerDb>`SELECT * FROM ad_allocation_events WHERE tenant_id = app.tenant_id() AND run_id = ${runId}::uuid ORDER BY occurred_at, id`.execute(tx);
  return r.rows.map(ledger);
}

export async function actionEvents(tx: Tx, actionId: string): Promise<LedgerRow[]> {
  const r = await sql<LedgerDb>`
    SELECT * FROM ad_allocation_events WHERE tenant_id = app.tenant_id()
       AND run_id IN (SELECT run_id FROM ad_allocation_events WHERE tenant_id = app.tenant_id() AND assistant_action_id = ${actionId}::uuid)
     ORDER BY occurred_at, id`.execute(tx);
  return r.rows.map(ledger);
}

/** Planned rows without an applied/failed outcome in their run, oldest first. */
export async function openPlans(tx: Tx): Promise<LedgerRow[]> {
  const r = await sql<LedgerDb>`
    SELECT p.* FROM ad_allocation_events p
     WHERE p.tenant_id = app.tenant_id() AND p.event_kind = 'planned'
       AND NOT EXISTS (SELECT 1 FROM ad_allocation_events o WHERE o.tenant_id = p.tenant_id AND o.run_id = p.run_id AND o.campaign_id = p.campaign_id
                         AND o.event_kind IN ('applied','failed'))
     ORDER BY p.occurred_at, p.id`.execute(tx);
  return r.rows.map(ledger);
}

/** A page of the ledger, newest first; `before` is the id of the last row of the previous page. */
export async function ledgerPage(tx: Tx, o: { before?: string | undefined; limit: number; campaignId?: string }): Promise<LedgerRow[]> {
  const cursor = o.before
    ? sql` AND (e.occurred_at, e.id) < (SELECT b.occurred_at, b.id FROM ad_allocation_events b WHERE b.tenant_id = app.tenant_id() AND b.id = ${o.before}::uuid)`
    : sql``;
  const camp = o.campaignId ? sql` AND e.campaign_id = ${o.campaignId}::uuid` : sql``;
  const r = await sql<LedgerDb>`SELECT e.* FROM ad_allocation_events e WHERE e.tenant_id = app.tenant_id()${cursor}${camp}
                                 ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${o.limit}`.execute(tx);
  return r.rows.map(ledger);
}

export async function eventExists(tx: Tx, id: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM ad_allocation_events WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid) AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

/** Whether a paused row of the campaign was recorded after `afterIso` (a pause wins over a later apply). */
export async function pausedSince(tx: Tx, campaignId: string, afterIso: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM ad_allocation_events WHERE tenant_id = app.tenant_id() AND campaign_id = ${campaignId}::uuid
                    AND event_kind = 'paused' AND occurred_at > ${afterIso}::timestamptz) AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

// ---- assistant actions (ad_reallocation) -----------------------------------------------------------------------------

export interface ActionRow {
  id: string;
  status: string;
  ownerUserId: string | null;
  contactId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  explanation: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  triggerRef: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: string;
}

type ActionDb = {
  id: string; kind: string; status: string; owner_user_id: string | null; contact_id: string | null; decided_by_user_id: string | null; decided_at: Date | null;
  explanation: string; payload: Record<string, unknown>; edited_payload: Record<string, unknown> | null; trigger_ref: Record<string, unknown>; dedupe_key: string | null; created_at: Date;
};
const action = (a: ActionDb): ActionRow => ({
  id: a.id, status: a.status, ownerUserId: a.owner_user_id, contactId: a.contact_id, decidedByUserId: a.decided_by_user_id, decidedAt: iso(a.decided_at),
  explanation: a.explanation, payload: a.payload, editedPayload: a.edited_payload, triggerRef: a.trigger_ref, dedupeKey: a.dedupe_key, createdAt: a.created_at.toISOString(),
});

/** An ad_reallocation by id (the caller's RLS decides whether it is visible). */
export async function reallocation(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<ActionRow | null> {
  const lock = o.forUpdate ? sql` FOR UPDATE` : sql``;
  const r = await sql<ActionDb>`SELECT * FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND kind = 'ad_reallocation'${lock}`.execute(tx);
  return r.rows[0] ? action(r.rows[0]) : null;
}

/** The newest ownerless ad_reallocation in one of `statuses` (a proposal or a hold). */
export async function latestReallocation(tx: Tx, statuses: readonly string[], o: { origin?: 'weekly' } = {}): Promise<ActionRow | null> {
  const weekly = o.origin === 'weekly' ? sql` AND dedupe_key LIKE 'ads_proposal:%'` : sql``;
  const r = await sql<ActionDb>`
    SELECT * FROM assistant_actions WHERE tenant_id = app.tenant_id() AND kind = 'ad_reallocation' AND owner_user_id IS NULL AND contact_id IS NULL
       AND status = ANY(${[...statuses]}::text[])${weekly}
     ORDER BY created_at DESC, id DESC LIMIT 1`.execute(tx);
  return r.rows[0] ? action(r.rows[0]) : null;
}

export async function reallocationByDedupe(tx: Tx, key: string): Promise<ActionRow | null> {
  const r = await sql<ActionDb>`SELECT * FROM assistant_actions WHERE tenant_id = app.tenant_id() AND dedupe_key = ${key}`.execute(tx);
  return r.rows[0] ? action(r.rows[0]) : null;
}

/** Inserts an ownerless, contactless ad_reallocation (money, requires approval). Returns false on a dedupe conflict. */
export async function insertReallocation(
  tx: Tx,
  a: { id: string; status: 'proposed' | 'blocked' | 'approved'; explanation: string; payload: Record<string, unknown>; dedupeKey: string | null; decidedByUserId?: string },
): Promise<boolean> {
  const decided = a.decidedByUserId ?? null;
  const r = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key,
                                   decided_by_user_id, decided_at)
    VALUES (app.tenant_id(), ${a.id}::uuid, NULL, 'ad_reallocation', 'money', 'requires_approval', ${a.status}, NULL, ${a.explanation.slice(0, 300)},
            ${JSON.stringify(a.payload)}::jsonb, ${a.dedupeKey}, ${decided}::uuid, CASE WHEN ${decided}::uuid IS NULL THEN NULL ELSE now() END)
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

/** A person's decision (approved / rejected), as themselves (the decision guard records the role). */
export async function decide(tx: Tx, id: string, status: 'approved' | 'rejected', userId: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = ${status}, decided_by_user_id = ${userId}::uuid, decided_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** Supersedes pending (proposed) ad_reallocations other than `exceptId`. */
export async function supersedePending(tx: Tx, exceptId: string | null): Promise<number> {
  const r = await sql`UPDATE assistant_actions SET status = 'superseded'
                       WHERE tenant_id = app.tenant_id() AND kind = 'ad_reallocation' AND status = 'proposed' AND owner_user_id IS NULL AND contact_id IS NULL
                         AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

export async function supersede(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'proposed'`.execute(tx);
}

export async function markExecuted(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = 'executed' WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'approved'`.execute(tx);
}

/** Marks campaigns as re-applied once in the action's trigger_ref (before the call: never a second re-apply). */
export async function markReapplied(tx: Tx, id: string, campaignId: string): Promise<boolean> {
  const r = await sql`
    UPDATE assistant_actions SET trigger_ref = jsonb_set(trigger_ref, '{reapplied}', COALESCE(trigger_ref->'reapplied', '[]'::jsonb) || to_jsonb(${campaignId}::text))
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND NOT (COALESCE(trigger_ref->'reapplied', '[]'::jsonb) ? ${campaignId}::text)`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

// ---- outcomes for proposals ------------------------------------------------------------------------------------------

/** Agreements and closings of deals carrying each campaign_ref since `sinceIso` (only `gads:` refs, the caller's). */
export async function dealOutcomes(tx: Tx, refs: readonly string[], sinceIso: string): Promise<Map<string, { agreements: number; closings: number }>> {
  if (refs.length === 0) return new Map();
  const r = await sql<{ campaign_ref: string; agreements: string; closings: string }>`
    SELECT campaign_ref, count(*) FILTER (WHERE agreement_signed_at >= ${sinceIso}::timestamptz) AS agreements,
           count(*) FILTER (WHERE closed_at >= ${sinceIso}::timestamptz) AS closings
      FROM deals WHERE tenant_id = app.tenant_id() AND campaign_ref = ANY(${[...refs]}::text[]) AND campaign_ref LIKE 'gads:%'
     GROUP BY campaign_ref`.execute(tx);
  return new Map(r.rows.map((x) => [x.campaign_ref, { agreements: n(x.agreements), closings: n(x.closings) }]));
}

// ---- costs (the only ads_sync writer, R-ADS-11) ----------------------------------------------------------------------

/** One ads_sync cost row per lead source and month: inserted or updated in place, never deleted; manual rows untouched. */
export async function upsertAdsSyncCost(tx: Tx, ids: IdGenerator, c: { leadSourceId: string; month: string; amountCents: number; note: string }): Promise<void> {
  await sql`INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin, note, entered_by_user_id)
            VALUES (app.tenant_id(), ${ids.next<'LeadSourceCostId'>()}::uuid, ${c.leadSourceId}::uuid, ${c.month}::date, ${c.amountCents}, 'ads_sync', ${c.note.slice(0, 500)}, NULL)
            ON CONFLICT (tenant_id, lead_source_id, month, origin)
            DO UPDATE SET amount_cents = EXCLUDED.amount_cents, note = EXCLUDED.note
            WHERE lead_source_costs.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents OR lead_source_costs.note IS DISTINCT FROM EXCLUDED.note`.execute(tx);
}

/** ads_sync rows of one month (the caller's RLS: Owner/Admin, or the system). */
export async function adsSyncCosts(tx: Tx, month: string): Promise<{ leadSourceId: string; amountCents: number; note: string | null }[]> {
  const r = await sql<{ lead_source_id: string; amount_cents: string; note: string | null }>`
    SELECT lead_source_id, amount_cents, note FROM lead_source_costs WHERE tenant_id = app.tenant_id() AND month = ${month}::date AND origin = 'ads_sync'
     ORDER BY lead_source_id`.execute(tx);
  return r.rows.map((x) => ({ leadSourceId: x.lead_source_id, amountCents: n(x.amount_cents), note: x.note }));
}

/** Lead sources with both a manual and an ads_sync row for the month (E451: the owner view would count both). */
export async function doubleCounted(tx: Tx, month: string): Promise<string[]> {
  const r = await sql<{ lead_source_id: string }>`
    SELECT lead_source_id FROM lead_source_costs WHERE tenant_id = app.tenant_id() AND month = ${month}::date
     GROUP BY lead_source_id HAVING count(*) FILTER (WHERE origin = 'manual') > 0 AND count(*) FILTER (WHERE origin = 'ads_sync') > 0
     ORDER BY lead_source_id`.execute(tx);
  return r.rows.map((x) => x.lead_source_id);
}

// ---- staff notifications (internal only: never a contact, D1) ---------------------------------------------------------

export async function ownersAndAdmins(tx: Tx): Promise<string[]> {
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND status = 'active' AND role IN ('owner','admin') ORDER BY user_id`.execute(tx);
  return r.rows.map((x) => x.user_id);
}

/**
 * One ad_overspend notification (high: in-app and web push to the person's own devices; never SMS), deduped per person.
 * Title ≤ 120 and body ≤ 240 characters (0001 CHECKs); text carries amounts and counts only (R-TEN-7).
 */
export async function notifyOverspend(tx: Tx, ids: IdGenerator, n_: { userId: string; title: string; body: string; connectionId: string; dedupeKey: string }): Promise<boolean> {
  const id = ids.next<'NotificationId'>();
  const r = await sql<{ id: string }>`
    INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
    VALUES (app.tenant_id(), ${id}::uuid, ${n_.userId}::uuid, 'ad_overspend', 'high', ${n_.title.slice(0, 120)}, ${n_.body.slice(0, 240)},
            'integration_connection', ${n_.connectionId}::uuid, ${n_.dedupeKey})
    ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING RETURNING id`.execute(tx);
  if (r.rows.length === 0) return false;
  await sql`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status)
            VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}::uuid, ${id}::uuid, 'in_app', 'in_app', 'delivered')`.execute(tx);
  const subs = await sql<{ id: string }>`SELECT id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND user_id = ${n_.userId}::uuid AND revoked_at IS NULL ORDER BY id`.execute(tx);
  for (const s of subs.rows) {
    await sql`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at)
              VALUES (app.tenant_id(), ${ids.next<'NotificationDeliveryId'>()}::uuid, ${id}::uuid, 'web_push', ${s.id}, 'pending', now())
              ON CONFLICT (tenant_id, notification_id, channel, target_ref) DO NOTHING`.execute(tx);
  }
  return true;
}
