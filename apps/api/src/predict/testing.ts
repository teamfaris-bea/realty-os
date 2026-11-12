// Test fixtures for api/predict (imported by *.test.ts only).
//
// SYNTHETIC models only: the point values below are placeholders for tests (no counsel-reviewed model exists,
// VERIFY WITH COUNSEL). core's own fixtures (packages/core/src/predict/testing) cannot be imported from apps/api
// and core/predict is not edited, so the definitions are written here. Each one is checked with core validateModel
// at load, and registered under a version unique to this process through an injected registry: prediction_models is
// global, so a version is never reused across tests. The superuser writes prediction_models rows exactly as the
// platform would (no app code writes that table), and fixtures without an application path (addresses, saved
// listing facts, closed deals) the same way. Every name and address is synthetic.
import { randomUUID } from 'node:crypto';
import { type ScorecardModel, validateModel } from '@realty/core/predict';
import { type Tx, withTenantTx } from '@realty/db';
import type { ApiHarness } from '../auth/testHarness.js';
import { memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { type ModelDefinition, defineModel } from './models.js';
import { type PassReport, type PredictDeps, runPredictionPass, type WithTx } from './pass.js';
import { FakePublicRecords } from './provider.js';

/** Synthetic: every allowed feature but stated_timeline_days (which has no stored source). */
export const PROPERTY_MODEL: Omit<ModelDefinition, 'version'> = {
  features: ['years_in_home', 'equity_band', 'recent_saves', 'past_client_years', 'recent_permit'],
  rules: [
    { feature: 'years_in_home', steps: [{ min: 10, points: 30 }, { min: 5, max: 9, points: 15 }] },
    { feature: 'equity_band', points: { high: 20, mid: 10 } },
    { feature: 'recent_saves', steps: [{ min: 3, points: 30 }, { min: 1, max: 2, points: 10 }] },
    { feature: 'past_client_years', steps: [{ min: 5, points: 10 }] },
    { feature: 'recent_permit', whenTrue: 10 },
  ],
  bandThresholds: { likely: 60, watch: 30 },
  minFeaturesPresent: 1,
};

/** Synthetic: first-party features only (no lookup is ever needed for it). */
export const FIRST_PARTY_MODEL: Omit<ModelDefinition, 'version'> = {
  features: ['recent_saves', 'past_client_years'],
  rules: [
    { feature: 'recent_saves', steps: [{ min: 3, points: 40 }, { min: 1, max: 2, points: 20 }] },
    { feature: 'past_client_years', steps: [{ min: 2, points: 20 }] },
  ],
  bandThresholds: { likely: 60, watch: 20 },
  minFeaturesPresent: 1,
};

export const TEST_BACKTEST = { flagged: 120, transacted: 31, windowDays: 90, dataset: 'synthetic platform back-test (test fixture)' } as const;

let seq = 0;
const base = 1000 + Math.floor(Math.random() * 8000);
/** A version no other test in this process uses. */
export const nextVersion = (): string => `predict/50.${base * 100 + ++seq}`;

/** The definition under `version`, frozen and checked with core validateModel as an approved model. */
export function definitionOf(spec: Omit<ModelDefinition, 'version'>, version = nextVersion()): ModelDefinition {
  const d = defineModel({ ...spec, version } as ModelDefinition);
  const v = validateModel({ ...d, status: 'approved', counselReviewedAt: '2026-10-01T00:00:00Z', backtest: TEST_BACKTEST } satisfies Partial<ScorecardModel>);
  if (!v.ok) throw new Error(`synthetic model invalid: ${v.issues.join('; ')}`);
  return d;
}

/** A writable registry, injected into the pass as production injects MODEL_DEFINITIONS. */
export function testRegistry(...defs: ModelDefinition[]): Map<string, ModelDefinition> {
  return new Map(defs.map((d) => [d.version, d]));
}

/** The platform releases a row for `version` (superuser: no app code writes prediction_models). */
export async function releaseModel(h: ApiHarness, version: string, features: readonly string[], status: 'draft' | 'approved' | 'withdrawn' = 'withdrawn'): Promise<void> {
  await h.su.query(
    `INSERT INTO prediction_models (version, status, features, counsel_reviewed_at, review_note, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset)
     VALUES ($1, $2, $3::text[], now(), 'synthetic test model', $4, $5, $6, $7)`,
    [version, status, [...features], TEST_BACKTEST.flagged, TEST_BACKTEST.transacted, TEST_BACKTEST.windowDays, TEST_BACKTEST.dataset],
  );
}
export const setModelStatus = (h: ApiHarness, version: string, status: 'draft' | 'approved' | 'withdrawn') => h.su.query('UPDATE prediction_models SET status = $2 WHERE version = $1', [version, status]);

/** A released and approved synthetic model, with its definition. */
export async function approvedModel(h: ApiHarness, spec: Omit<ModelDefinition, 'version'> = PROPERTY_MODEL): Promise<ModelDefinition> {
  const d = definitionOf(spec);
  await releaseModel(h, d.version, d.features);
  await setModelStatus(h, d.version, 'approved');
  return d;
}

export type Addr = { line1: string; line2?: string | null; city: string; region: string; postalCode: string };
let street = 100;
/** A synthetic address no other test uses. */
export const nextAddress = (): Addr => ({ line1: `${++street} Synthetic Test Way`, city: 'Exampleton', region: 'CA', postalCode: '90001' });

export async function homeAddress(h: ApiHarness, tenantId: string, contactId: string, a: Addr = nextAddress(), kind = 'home'): Promise<{ id: string; address: Addr }> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, id, contactId, kind, a.line1, a.line2 ?? null, a.city, a.region, a.postalCode],
  );
  return { id, address: a };
}

/** `n` listing_saved behavior events (reliability fact by default) within the last days. */
export async function savedListings(h: ApiHarness, tenantId: string, contactId: string, n: number, reliability: 'fact' | 'signal' = 'fact', daysAgo = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await h.su.query(
      `INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, source, occurred_at, dedupe_key)
       VALUES ($1, $2, $3, 'listing_saved', $4, 'website', now() - make_interval(days => $5), $6)`,
      [tenantId, randomUUID(), contactId, reliability, daysAgo, `test-save-${randomUUID()}`],
    );
  }
}

/** A vendor payload for the fake (any extra fields are what the strict parser must drop). */
export function vendorRecord(a: Addr, ownerNames: string[], o: { lastSaleDate?: string; lastSalePriceCents?: number; assessedValueCents?: number; recentPermit?: boolean; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    address: a,
    ownerNames,
    lastSaleDate: o.lastSaleDate ?? '2012-05-01',
    lastSalePriceCents: o.lastSalePriceCents ?? 40_000_000,
    assessedValueCents: o.assessedValueCents ?? 70_000_000,
    recentPermit: o.recentPermit ?? false,
    providerRef: `fake-${randomUUID()}`,
    ...(o.extra ?? {}),
  };
}

export const tenantTx = (h: ApiHarness, tenantId: string): WithTx => (fn) => withTenantTx(systemActor(tenantId, 'worker'), fn, { db: h.database });

/** One pass for a tenant (night window off unless asked), returning the report and the alerts it raised. */
export async function pass(h: ApiHarness, tenantId: string, deps: Partial<PredictDeps> & { registry: PredictDeps['registry'] }, o: { nightOnly?: boolean } = {}) {
  const alerts = memoryAlerts();
  const report: PassReport = await runPredictionPass(tenantTx(h, tenantId), { publicRecords: deps.publicRecords ?? new FakePublicRecords(), ...deps }, { tenantId, alerts, nightOnly: o.nightOnly ?? false });
  return { report, alerts: alerts.alerts };
}

/** Row counts of the tables a prediction must never touch (E121). */
export async function sideEffectCounts(h: ApiHarness, tenantId: string): Promise<Record<string, number>> {
  const tables = ['messages', 'calls', 'notifications', 'notification_deliveries', 'assistant_actions', 'assistant_claims', 'playbook_step_runs', 'playbook_enrollments', 'tasks',
    'lead_ownership_events', 'ownership_command_rejections', 'routing_rotation_state', 'ad_campaigns', 'ad_allocation_events', 'portal_items', 'portal_grants', 'voice_tool_calls', 'audit_log'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = Number((await h.su.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  }
  out.jobs = Number((await h.su.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind <> 'predict.nightly'`, [tenantId])).rows[0].n);
  return out;
}

export const rowsOf = async (h: ApiHarness, contactId: string) => ({
  records: (await h.su.query('SELECT * FROM property_records WHERE contact_id = $1', [contactId])).rows,
  predictions: (await h.su.query('SELECT * FROM contact_predictions WHERE contact_id = $1 ORDER BY model_version', [contactId])).rows,
  cards: (await h.su.query(`SELECT * FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'likely_to_move' ORDER BY created_at`, [contactId])).rows,
});

export type { Tx };
