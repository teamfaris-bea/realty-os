// The nightly prediction pass of module 50 (R-OWN-27: prediction refresh, nightly per tenant and date; R-PRED-1..6;
// E120, E121, E122, E144; R-DATA-6).
//
// One pass per tenant, woken hourly by its reconcile handler (handlers.ts); it acts only in the tenant's night window
// (tenant_settings.default_timezone), and everything it writes is keyed by the tenant's LOCAL date, so a second run on
// the same date writes nothing and makes no lookup. Steps, each in bounded transactions as the system actor:
//   0. CONTEXT (tx): the local date and hour; retention (app.purge_prediction_data, R-DATA-6); the approved
//      prediction_models rows, resolved against the injected definitions (models.ts). A row that cannot score raises
//      WORKER_ERROR / PREDICTION_MODEL_INVALID and gets nothing written. With no model able to score, the pass stops:
//      it reads no contact and writes no prediction, record or card.
//   1. PROPERTY RECORDS (only while a scoring model names years_in_home, equity_band or recent_permit, and only with
//      a configured provider): due home addresses of live, owned, listable contacts, within the per-day lookup budget.
//      Each lookup runs OUTSIDE any transaction; its write is its own transaction, fenced on the address row (an
//      address edited meanwhile is not written; the next pass finds it due). Upsert by contact_address_id, so a crash
//      between a lookup and its write leaves no duplicate, and a re-run repeats only the lookups in flight.
//   2. CLOSE ORPHANED CARDS (tx): an open card of a scoring model whose contact left the scored population (deleted,
//      merged, no longer owned) is closed by condition.
//   3. SCORE AND CARD (one tx per batch of contacts): the six features (decide.ts assembleFeatures; never
//      contact_attributes), core scoreWithModel, then for each prediction: close cards that should not be open, write
//      the changed predictions (computed_on re-stamped to the local date; an unchanged row is not touched), then write
//      the one card for the current owner (update in place, reopen a card closed by condition, never re-insert a card
//      the agent closed).
// Withdrawal is never a write: rows of a model that cannot score are not read or touched, and RLS hides them
// (predictions_select, likely_to_move_model_live, feed.ts shownCards). A model withdrawn mid-pass drops out at the
// next batch; anything written for it in the batch that raced is hidden by the same policies.
// A prediction produces nothing but its card (R-PRED-4, E121): no message, call, notification, draft, assistant
// action, enrollment, trigger run, task, ownership command, routing input, ad or portal item, and no AI call.
// Logs carry counts and ids only (R-TEN-7); names are compared in memory (core attachPropertyRecord) and never stored,
// hashed or logged.
import { randomFillSync } from 'node:crypto';
import { type IdGenerator, type Instant, instant, uuidv7Generator } from '@realty/core/foundation';
import { type ApprovedModel, type PostalAddress, type Reason, scoreWithModel, storedReasons } from '@realty/core/predict';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { AlertSink } from '../worker/observability.js';
import { ProviderError } from '../providers/types.js';
import {
  type AddressCandidate,
  type CardContact,
  type DesiredCard,
  type FeatureInputs,
  assembleFeatures,
  budgetLeft,
  desiredCard,
  isNightHour,
  recordFromLookup,
  selectLookups,
} from './decide.js';
import { type ModelRegistry, type ModelRow, needsPropertyRecords, resolveModels } from './models.js';
import type { PublicRecordsProvider } from './provider.js';
import { type PredictSettings, resolveSettings } from './settings.js';

export type WithTx = <T>(fn: (tx: Tx, now: Instant) => Promise<T>) => Promise<T>;

export interface PredictDeps {
  publicRecords: PublicRecordsProvider;
  /** the version → definition registry (MODEL_DEFINITIONS in production; tests inject synthetic ones) */
  registry: ModelRegistry;
  settings?: Partial<PredictSettings>;
  ids?: IdGenerator;
}

export interface PassReport {
  outcome: 'not_night' | 'no_model' | 'done';
  localDate: string;
  scoringModels: string[];
  invalidModels: { version: string; reason: string }[];
  purged: { records: number; predictions: number };
  lookups: { made: number; attached: number; needsReview: number; notAvailable: number; failed: number; fenced: number; providerConfigured: boolean };
  predictions: { evaluated: number; written: number };
  cards: { inserted: number; updated: number; reopened: number; closed: number };
}

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));

function emptyReport(localDate: string): PassReport {
  return {
    outcome: 'done',
    localDate,
    scoringModels: [],
    invalidModels: [],
    purged: { records: 0, predictions: 0 },
    lookups: { made: 0, attached: 0, needsReview: 0, notAvailable: 0, failed: 0, fenced: 0, providerConfigured: false },
    predictions: { evaluated: 0, written: 0 },
    cards: { inserted: 0, updated: 0, reopened: 0, closed: 0 },
  };
}

/** One pass for the tenant of `withTx` (every transaction is that tenant's system actor). */
export async function runPredictionPass(withTx: WithTx, deps: PredictDeps, o: { tenantId: string; alerts: AlertSink; nightOnly: boolean }): Promise<PassReport> {
  const s = resolveSettings(deps.settings);
  const ids = deps.ids ?? uuidv7Generator({ now: () => instant(Date.now()) }, (n) => randomFillSync(new Uint8Array(n)));

  // 0. context, retention, models
  const ctx = await withTx(async (tx) => {
    const t = await sql<{ tz: string; local_date: string; local_hour: number }>`
      SELECT s.default_timezone AS tz, (now() AT TIME ZONE s.default_timezone)::date::text AS local_date,
             extract(hour FROM now() AT TIME ZONE s.default_timezone)::int AS local_hour
        FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
    const row = t.rows[0];
    if (!row) throw new Error('PREDICT_NO_TENANT_SETTINGS');
    if (o.nightOnly && !isNightHour(row.local_hour, s)) return { ...row, purged: null, models: [] as ModelRow[] };
    const p = await sql<{ records_deleted: number; predictions_deleted: number }>`SELECT * FROM app.purge_prediction_data()`.execute(tx);
    const m = await sql<ModelRow>`
      SELECT version, status, features, counsel_reviewed_at, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset
        FROM prediction_models WHERE status = 'approved' ORDER BY version`.execute(tx);
    return { ...row, purged: p.rows[0] ?? { records_deleted: 0, predictions_deleted: 0 }, models: m.rows };
  });
  const report = emptyReport(ctx.local_date);
  if (ctx.purged === null) return { ...report, outcome: 'not_night' };
  report.purged = { records: ctx.purged.records_deleted, predictions: ctx.purged.predictions_deleted };

  const resolved = resolveModels(ctx.models, deps.registry);
  report.invalidModels = resolved.invalid;
  for (const bad of resolved.invalid) {
    o.alerts.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: o.tenantId, details: { reason: 'PREDICTION_MODEL_INVALID', modelVersion: bad.version, detail: bad.reason } });
  }
  report.scoringModels = resolved.scoring.map((m) => m.version);
  if (resolved.scoring.length === 0) return { ...report, outcome: 'no_model' };

  // 1. property records
  report.lookups.providerConfigured = deps.publicRecords.configured;
  if (deps.publicRecords.configured && needsPropertyRecords(resolved.scoring)) {
    await refreshPropertyRecords(withTx, deps.publicRecords, ids, s, ctx.local_date, report);
  }

  // 2. close the cards of contacts that left the scored population
  const versions = resolved.scoring.map((m) => m.version);
  report.cards.closed += await withTx(async (tx) => {
    const r = await sql`
      UPDATE priority_feed_items f SET state = 'done', snoozed_until = NULL, resolved_at = now(), resolved_by = 'condition', updated_at = now()
       WHERE f.tenant_id = app.tenant_id() AND f.item_type = 'likely_to_move' AND f.state IN ('open','snoozed')
         AND f.dedupe_key LIKE 'likely:%' AND split_part(f.dedupe_key, ':', 3) = ANY (${versions}::text[])
         AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = f.tenant_id AND c.id = f.contact_id AND c.deleted_at IS NULL
                            AND c.merged_into_contact_id IS NULL AND c.ownership_state = 'owned')`.execute(tx);
    return Number(r.numAffectedRows ?? 0);
  });

  // 3. score and card, one bounded transaction per batch of contacts
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const n = await withTx(async (tx, now) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('predict.pass:' || app.tenant_id()::text, 0))`.execute(tx);
      const batch = await sql<{ id: string; ownership_state: string; owner_user_id: string | null; dnc: boolean; closed_reason: string | null }>`
        SELECT c.id, c.ownership_state, c.owner_user_id, (c.do_not_contact_at IS NOT NULL) AS dnc, c.closed_reason
          FROM contacts c
         WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
           AND c.ownership_state = 'owned' AND c.id > ${cursor}::uuid
         ORDER BY c.id LIMIT ${s.batchSize}`.execute(tx);
      if (batch.rows.length === 0) return 0;
      cursor = batch.rows[batch.rows.length - 1]!.id;
      // a model withdrawn since step 0 drops out here (R-PRED-5)
      const live = await sql<{ version: string }>`SELECT version FROM prediction_models WHERE version = ANY (${versions}::text[]) AND status = 'approved'`.execute(tx);
      const liveSet = new Set(live.rows.map((r) => r.version));
      const models = resolved.scoring.filter((m) => liveSet.has(m.version));
      if (models.length > 0) await scoreBatch(tx, now, models, batch.rows, ids, s, ctx.local_date, report);
      return batch.rows.length;
    });
    if (n < s.batchSize) break;
  }
  return report;
}

// ---- 1. property records ----------------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  contact_id: string;
  kind: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  updated_at: Date;
  fetched_at: Date | null;
  k: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
}

const PAGE = 200;

async function refreshPropertyRecords(withTx: WithTx, provider: PublicRecordsProvider, ids: IdGenerator, s: PredictSettings, localDate: string, report: PassReport): Promise<void> {
  let madeThisPass = 0;
  let cursor: { k: string; id: string } = { k: '-infinity', id: '00000000-0000-0000-0000-000000000000' };
  for (;;) {
    const page = await withTx(async (tx, now) => {
      const fetchedToday = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM property_records pr JOIN tenant_settings ts ON ts.tenant_id = pr.tenant_id
         WHERE pr.tenant_id = app.tenant_id() AND (pr.fetched_at AT TIME ZONE ts.default_timezone)::date = ${localDate}::date`.execute(tx);
      const left = budgetLeft(s.lookupBudgetPerDay, fetchedToday.rows[0]?.n ?? 0, madeThisPass);
      if (left <= 0) return { now, rows: [] as CandidateRow[], left };
      // names are read for the in-memory attach decision only; they are never written, hashed or logged
      const r = await sql<CandidateRow>`
        SELECT a.id, a.contact_id, a.kind, a.line1, a.line2, a.city, a.region, a.postal_code, a.updated_at, pr.fetched_at,
               COALESCE(pr.fetched_at, '-infinity'::timestamptz)::text AS k, c.first_name, c.last_name, c.display_name
          FROM contact_addresses a
          JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
          LEFT JOIN property_records pr ON pr.tenant_id = a.tenant_id AND pr.contact_address_id = a.id
         WHERE a.tenant_id = app.tenant_id() AND a.kind = 'home'
           AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL AND c.ownership_state = 'owned'
           AND c.do_not_contact_at IS NULL AND c.closed_reason IS DISTINCT FROM 'do_not_contact'
           AND a.line1 IS NOT NULL AND a.city IS NOT NULL AND a.region IS NOT NULL AND a.postal_code IS NOT NULL
           AND (pr.id IS NULL OR pr.fetched_at <= now() - make_interval(days => ${s.refreshAgeDays}) OR a.updated_at > pr.fetched_at)
           AND (COALESCE(pr.fetched_at, '-infinity'::timestamptz), a.id) > (${cursor.k}::timestamptz, ${cursor.id}::uuid)
         ORDER BY COALESCE(pr.fetched_at, '-infinity'::timestamptz), a.id
         LIMIT ${PAGE}`.execute(tx);
      return { now, rows: r.rows, left };
    });
    if (page.rows.length === 0) return;
    const last = page.rows[page.rows.length - 1]!;
    cursor = { k: last.k, id: last.id };
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    const cands: AddressCandidate[] = page.rows.map((r) => ({
      addressId: r.id,
      contactId: r.contact_id,
      kind: r.kind,
      contactLive: true,
      contactOwned: true,
      doNotContact: false,
      address: { line1: r.line1, line2: r.line2, city: r.city, region: r.region, postalCode: r.postal_code },
      updatedAt: instant(ms(r.updated_at)),
      fetchedAt: r.fetched_at === null ? null : instant(ms(r.fetched_at)),
    }));
    const chosen = selectLookups(cands, { now: page.now, refreshAgeDays: s.refreshAgeDays, budgetLeft: page.left, purpose: true });
    for (const c of chosen) {
      const row = byId.get(c.addressId)!;
      // the adapter gets exactly one address: no name, no contact id, no tenant
      const address: PostalAddress = { line1: c.address.line1, line2: c.address.line2 ?? null, city: c.address.city, region: c.address.region, postalCode: c.address.postalCode };
      madeThisPass += 1;
      report.lookups.made += 1;
      let lookup;
      try {
        lookup = await provider.lookup(address);
      } catch (e) {
        if (e instanceof ProviderError) {
          report.lookups.failed += 1;
          if (e.kind === 'not_configured') return;
          continue;
        }
        throw e;
      }
      const names = [row.display_name, [row.first_name, row.last_name].filter((x) => x !== null && x.trim() !== '').join(' ')].filter((n) => n.trim() !== '');
      const w = recordFromLookup(lookup, { address: c.address, names });
      const wrote = await withTx(async (tx) => {
        // fence: the address is still the one looked up, still a home of a live, owned contact
        const fence = await sql<{ updated_at: Date }>`
          SELECT a.updated_at FROM contact_addresses a JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
           WHERE a.tenant_id = app.tenant_id() AND a.id = ${c.addressId}::uuid AND a.kind = 'home' AND a.contact_id = ${c.contactId}::uuid
             AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL AND c.ownership_state = 'owned'
           FOR SHARE OF a`.execute(tx);
        const f = fence.rows[0];
        if (!f || ms(f.updated_at) !== c.updatedAt) return false;
        const facts = w.facts;
        await sql`
          INSERT INTO property_records (tenant_id, id, contact_id, contact_address_id, last_sale_date, last_sale_price_cents, assessed_value_cents,
                                        mortgage_origination_date, owner_occupied, owner_name_match, recent_permit, provider_ref, fetched_at, retention_until)
          VALUES (app.tenant_id(), ${ids.next<'PropertyRecordId'>()}::uuid, ${c.contactId}::uuid, ${c.addressId}::uuid,
                  ${facts?.lastSaleDate ?? null}::date, ${facts?.lastSalePriceCents ?? null}::bigint, ${facts?.assessedValueCents ?? null}::bigint,
                  NULL, NULL, ${w.ownerNameMatch}, ${facts?.recentPermit ?? null}::boolean, ${w.providerRef},
                  now(), now() + make_interval(days => ${s.recordRetentionDays}))
          ON CONFLICT (tenant_id, contact_address_id) DO UPDATE SET
            contact_id = EXCLUDED.contact_id, last_sale_date = EXCLUDED.last_sale_date, last_sale_price_cents = EXCLUDED.last_sale_price_cents,
            assessed_value_cents = EXCLUDED.assessed_value_cents, mortgage_origination_date = NULL, owner_occupied = NULL,
            owner_name_match = EXCLUDED.owner_name_match, recent_permit = EXCLUDED.recent_permit, provider_ref = EXCLUDED.provider_ref,
            fetched_at = EXCLUDED.fetched_at, retention_until = EXCLUDED.retention_until`.execute(tx);
        return true;
      });
      if (!wrote) {
        report.lookups.fenced += 1;
        continue;
      }
      if (w.outcome === 'attached') report.lookups.attached += 1;
      else if (w.outcome === 'needs_review') report.lookups.needsReview += 1;
      else report.lookups.notAvailable += 1;
    }
    if (chosen.length >= page.left) return; // the budget is spent
  }
}

// ---- 3. features, predictions, cards ----------------------------------------------------------------------

type BatchContact = { id: string; ownership_state: string; owner_user_id: string | null; dnc: boolean; closed_reason: string | null };

/** The feature inputs of a batch. Reads property_records, behavior_events and deals only (never contact_attributes). */
async function loadFeatureInputs(tx: Tx, contactIds: string[], models: readonly ApprovedModel[], s: PredictSettings): Promise<Map<string, FeatureInputs>> {
  const want = new Set(models.flatMap((m) => m.features));
  const out = new Map<string, FeatureInputs>(contactIds.map((id) => [id, { contactId: id, record: null, recentSaves: null, lastClosedDeal: null }]));
  if (want.has('years_in_home') || want.has('equity_band') || want.has('recent_permit')) {
    const r = await sql<{ contact_id: string; id: string; owner_name_match: boolean; last_sale_date: string | null; last_sale_price_cents: string | null; assessed_value_cents: string | null; recent_permit: boolean | null }>`
      SELECT DISTINCT ON (pr.contact_id) pr.contact_id, pr.id, pr.owner_name_match, pr.last_sale_date::text AS last_sale_date,
             pr.last_sale_price_cents::text AS last_sale_price_cents, pr.assessed_value_cents::text AS assessed_value_cents, pr.recent_permit
        FROM property_records pr
        JOIN contact_addresses a ON a.tenant_id = pr.tenant_id AND a.id = pr.contact_address_id AND a.contact_id = pr.contact_id
       WHERE pr.tenant_id = app.tenant_id() AND pr.contact_id = ANY (${contactIds}::uuid[]) AND a.kind = 'home'
         AND pr.owner_name_match AND pr.retention_until > now() AND pr.fetched_at >= a.updated_at
       ORDER BY pr.contact_id, pr.fetched_at DESC, pr.id`.execute(tx);
    for (const x of r.rows) {
      const big = (v: string | null) => (v === null ? null : Number(v));
      out.get(x.contact_id)!.record = { id: x.id, ownerNameMatch: x.owner_name_match, lastSaleDate: x.last_sale_date, lastSalePriceCents: big(x.last_sale_price_cents), assessedValueCents: big(x.assessed_value_cents), recentPermit: x.recent_permit };
    }
  }
  if (want.has('recent_saves')) {
    const r = await sql<{ contact_id: string; n: number }>`
      SELECT contact_id, LEAST(count(*), 10000)::int AS n FROM behavior_events
       WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${contactIds}::uuid[]) AND event_type = 'listing_saved' AND reliability = 'fact'
         AND occurred_at > now() - make_interval(days => ${s.recentSavesWindowDays}) AND occurred_at <= now()
       GROUP BY contact_id`.execute(tx);
    const counts = new Map(r.rows.map((x) => [x.contact_id, x.n]));
    for (const [id, i] of out) i.recentSaves = counts.get(id) ?? 0;
  }
  if (want.has('past_client_years')) {
    const r = await sql<{ contact_id: string; deal_id: string; closed_at: Date }>`
      SELECT DISTINCT ON (x.contact_id) x.contact_id, d.id AS deal_id, d.closed_at
        FROM (SELECT d0.id AS deal_id, d0.primary_contact_id AS contact_id FROM deals d0
               WHERE d0.tenant_id = app.tenant_id() AND d0.primary_contact_id = ANY (${contactIds}::uuid[])
              UNION
              SELECT dc.deal_id, dc.contact_id FROM deal_contacts dc
               WHERE dc.tenant_id = app.tenant_id() AND dc.contact_id = ANY (${contactIds}::uuid[]) AND dc.role IN ('buyer','seller','co_buyer','co_seller')) x
        JOIN deals d ON d.tenant_id = app.tenant_id() AND d.id = x.deal_id
       WHERE d.stage = 'closed' AND d.closed_at IS NOT NULL AND d.closed_at <= now()
       ORDER BY x.contact_id, d.closed_at DESC, d.id`.execute(tx);
    for (const x of r.rows) out.get(x.contact_id)!.lastClosedDeal = { dealId: x.deal_id, closedAt: instant(ms(x.closed_at)) };
  }
  return out;
}

interface Scored {
  contactId: string;
  version: string;
  band: string;
  reasons: Reason[];
  stored: ReturnType<typeof storedReasons>;
  sha: string;
}

const canon = (v: unknown) => JSON.stringify(v);

async function scoreBatch(tx: Tx, now: Instant, models: readonly ApprovedModel[], contacts: BatchContact[], ids: IdGenerator, s: PredictSettings, localDate: string, report: PassReport): Promise<void> {
  const contactIds = contacts.map((c) => c.id);
  const versions = models.map((m) => m.version);
  const inputs = await loadFeatureInputs(tx, contactIds, models, s);

  const scored: Scored[] = [];
  for (const m of models) {
    for (const c of contacts) {
      const a = assembleFeatures(inputs.get(c.id)!, now, m.features, s);
      const r = scoreWithModel(a.features, m, a.evidence);
      if (!r.ok) continue;
      scored.push({ contactId: c.id, version: m.version, band: r.result.band, reasons: r.result.reasons, stored: storedReasons(r.result.reasons), sha: r.inputsSha256 });
    }
  }
  report.predictions.evaluated += scored.length;

  // the cards these predictions make (one per contact and model, for the current owner)
  const byContact = new Map(contacts.map((c) => [c.id, c]));
  const modelOf = new Map(models.map((m) => [m.version, m]));
  const desired = new Map<string, DesiredCard>();
  for (const p of scored) {
    const c = byContact.get(p.contactId)!;
    const cc: CardContact = { contactId: c.id, live: true, ownershipState: c.ownership_state, ownerUserId: c.owner_user_id, doNotContact: c.dnc, closedReason: c.closed_reason };
    const d = desiredCard(p, modelOf.get(p.version)!, cc);
    if (d) desired.set(`${d.userId}|${d.dedupeKey}`, d);
  }

  // (a) close what should not be open, while the old predictions still make the cards visible
  const cardRows = () =>
    sql<{ id: string; user_id: string; dedupe_key: string; state: string; resolved_by: string | null; reasons: unknown; score: number; resolved_at: Date | null }>`
      SELECT id, user_id, dedupe_key, state, resolved_by, reasons, score, resolved_at FROM priority_feed_items
       WHERE tenant_id = app.tenant_id() AND item_type = 'likely_to_move' AND contact_id = ANY (${contactIds}::uuid[])
         AND dedupe_key LIKE 'likely:%' AND split_part(dedupe_key, ':', 3) = ANY (${versions}::text[])`.execute(tx);
  const before = await cardRows();
  const toClose = before.rows.filter((r) => (r.state === 'open' || r.state === 'snoozed') && !desired.has(`${r.user_id}|${r.dedupe_key}`)).map((r) => r.id);
  if (toClose.length > 0) {
    const r = await sql`UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = now(), resolved_by = 'condition', updated_at = now()
                         WHERE tenant_id = app.tenant_id() AND id = ANY (${toClose}::uuid[]) AND state IN ('open','snoozed')`.execute(tx);
    report.cards.closed += Number(r.numAffectedRows ?? 0);
  }

  // (b) predictions: write only what changed (computed_on is part of it, so the first run of a date re-stamps every
  //     evaluated row and a second run of the same date writes nothing)
  const existing = await sql<{ contact_id: string; model_version: string; band: string; reasons: unknown; inputs_sha256: string; computed_on: string }>`
    SELECT contact_id, model_version, band, reasons, inputs_sha256, computed_on::text AS computed_on FROM contact_predictions
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${contactIds}::uuid[]) AND model_version = ANY (${versions}::text[])`.execute(tx);
  const old = new Map(existing.rows.map((r) => [`${r.contact_id}|${r.model_version}`, r]));
  const changed: Scored[] = [];
  const fresh: Scored[] = [];
  for (const p of scored) {
    const e = old.get(`${p.contactId}|${p.version}`);
    if (!e) fresh.push(p);
    else if (e.band !== p.band || canon(e.reasons) !== canon(p.stored) || e.inputs_sha256 !== p.sha || e.computed_on !== localDate) changed.push(p);
  }
  const recs = (xs: Scored[]) => JSON.stringify(xs.map((p) => ({ contact_id: p.contactId, model_version: p.version, band: p.band, reasons: p.stored, inputs_sha256: p.sha })));
  if (changed.length > 0) {
    const r = await sql`
      UPDATE contact_predictions cp SET band = x.band, reasons = x.reasons, inputs_sha256 = x.inputs_sha256, computed_on = ${localDate}::date
        FROM jsonb_to_recordset(${recs(changed)}::jsonb) AS x(contact_id uuid, model_version text, band text, reasons jsonb, inputs_sha256 text)
       WHERE cp.tenant_id = app.tenant_id() AND cp.contact_id = x.contact_id AND cp.model_version = x.model_version`.execute(tx);
    report.predictions.written += Number(r.numAffectedRows ?? 0);
  }
  if (fresh.length > 0) {
    const r = await sql`
      INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
      SELECT app.tenant_id(), x.contact_id, x.model_version, x.band, x.reasons, x.inputs_sha256, ${localDate}::date
        FROM jsonb_to_recordset(${recs(fresh)}::jsonb) AS x(contact_id uuid, model_version text, band text, reasons jsonb, inputs_sha256 text)
      ON CONFLICT (tenant_id, contact_id, model_version) DO NOTHING`.execute(tx);
    report.predictions.written += Number(r.numAffectedRows ?? 0);
  }

  // (c) the cards, now visible under the new predictions
  if (desired.size === 0) return;
  const after = await cardRows();
  const rowsOf = new Map<string, typeof after.rows>();
  for (const r of after.rows) {
    const k = `${r.user_id}|${r.dedupe_key}`;
    rowsOf.set(k, [...(rowsOf.get(k) ?? []), r]);
  }
  for (const [k, d] of desired) {
    const rows = rowsOf.get(k) ?? [];
    const openRow = rows.find((r) => r.state === 'open' || r.state === 'snoozed');
    if (openRow) {
      if (canon(openRow.reasons) !== canon(d.reasons) || openRow.score !== d.score) {
        await sql`UPDATE priority_feed_items SET reasons = ${JSON.stringify(d.reasons)}::jsonb, score = ${d.score}, updated_at = now()
                   WHERE tenant_id = app.tenant_id() AND id = ${openRow.id}::uuid`.execute(tx);
        report.cards.updated += 1;
      }
      continue;
    }
    // the agent's own close (or another module's) is final for that user and key
    if (rows.some((r) => r.resolved_by !== 'condition')) continue;
    const reopen = [...rows].sort((a, b) => ms(b.resolved_at ?? new Date(0)) - ms(a.resolved_at ?? new Date(0)))[0];
    if (reopen) {
      await sql`UPDATE priority_feed_items SET state = 'open', resolved_at = NULL, resolved_by = NULL, reasons = ${JSON.stringify(d.reasons)}::jsonb,
                       score = ${d.score}, updated_at = now()
                 WHERE tenant_id = app.tenant_id() AND id = ${reopen.id}::uuid AND state = 'done' AND resolved_by = 'condition'`.execute(tx);
      report.cards.reopened += 1;
      continue;
    }
    const r = await sql`
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at, score, score_version, reasons, dedupe_key)
      VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}::uuid, ${d.userId}::uuid, 'likely_to_move', 'scored', ${d.contactId}::uuid, 'contact',
              ${d.contactId}::uuid, NULL, ${d.score}, 1, ${JSON.stringify(d.reasons)}::jsonb, ${d.dedupeKey})
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO NOTHING`.execute(tx);
    report.cards.inserted += Number(r.numAffectedRows ?? 0);
  }
}
