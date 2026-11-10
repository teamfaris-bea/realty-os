// tenant_settings (RLS: members read, Owner/Admin update; tenant_settings_guard makes brokerage
// identity, recording retention/access, MFA roles and activating a loosened policy Owner-only).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface SettingsRow {
  version: number;
  default_timezone: string;
  routing_hours_start: string;
  routing_hours_end: string;
  offer_window_seconds: number;
  max_offers: number;
  first_touch_sla_seconds: number;
  first_touch_release_seconds: number | null;
  reinquiry_sla_after_days: number;
  inactivity_release_days: number | null;
  inactivity_warning_hours: number;
  auto_pause_after_misses: number;
  uncontacted_capacity_cap: number;
  isa_access_after_handoff_days: number;
  recording_retention_days: number;
  team_lead_recording_access: boolean;
  tc_recording_access: boolean;
  notification_detail: 'none' | 'first_name_initial';
  ai_enabled: boolean;
  active_policy_id: string;
  brokerage_legal_name: string;
  team_name: string | null;
  brokerage_license_number: string | null;
  brokerage_postal_address: string | null;
}

/** The columns PATCH /settings and PATCH /settings/identity may write (snake_case = column). */
export const WRITABLE_COLUMNS = [
  'default_timezone',
  'routing_hours_start',
  'routing_hours_end',
  'offer_window_seconds',
  'max_offers',
  'first_touch_sla_seconds',
  'first_touch_release_seconds',
  'reinquiry_sla_after_days',
  'inactivity_release_days',
  'inactivity_warning_hours',
  'auto_pause_after_misses',
  'uncontacted_capacity_cap',
  'isa_access_after_handoff_days',
  'recording_retention_days',
  'team_lead_recording_access',
  'tc_recording_access',
  'notification_detail',
  'ai_enabled',
  'brokerage_legal_name',
  'team_name',
  'brokerage_license_number',
  'brokerage_postal_address',
] as const satisfies readonly (keyof SettingsRow)[];
export type WritableColumn = (typeof WRITABLE_COLUMNS)[number];

export async function getSettings(tx: Tx, opts: { forUpdate?: boolean } = {}): Promise<SettingsRow | null> {
  const lock = opts.forUpdate ? sql`FOR NO KEY UPDATE` : sql``;
  return (
    (
      await sql<SettingsRow>`
        SELECT version, default_timezone, routing_hours_start::text AS routing_hours_start, routing_hours_end::text AS routing_hours_end,
               offer_window_seconds, max_offers, first_touch_sla_seconds, first_touch_release_seconds, reinquiry_sla_after_days,
               inactivity_release_days, inactivity_warning_hours, auto_pause_after_misses, uncontacted_capacity_cap,
               isa_access_after_handoff_days, recording_retention_days, team_lead_recording_access, tc_recording_access,
               notification_detail, ai_enabled, active_policy_id, brokerage_legal_name, team_name, brokerage_license_number,
               brokerage_postal_address
          FROM tenant_settings WHERE tenant_id = app.tenant_id() ${lock}`.execute(tx)
    ).rows[0] ?? null
  );
}

/** Writes the given columns and bumps the version (column names come from WRITABLE_COLUMNS only). */
export async function updateSettings(tx: Tx, changes: Partial<Record<WritableColumn, unknown>>): Promise<void> {
  const cols = Object.keys(changes).filter((k): k is WritableColumn => (WRITABLE_COLUMNS as readonly string[]).includes(k));
  if (cols.length === 0) return;
  const sets = cols.map((c) => {
    const v = changes[c];
    const isTime = c === 'routing_hours_start' || c === 'routing_hours_end';
    return isTime ? sql`${sql.ref(c)} = ${v as string}::time` : sql`${sql.ref(c)} = ${v as never}`;
  });
  await sql`UPDATE tenant_settings SET ${sql.join(sets, sql`, `)}, version = version + 1 WHERE tenant_id = app.tenant_id()`.execute(tx);
}

export async function setActivePolicy(tx: Tx, policyId: string): Promise<void> {
  await sql`UPDATE tenant_settings SET active_policy_id = ${policyId}::uuid, version = version + 1 WHERE tenant_id = app.tenant_id()`.execute(tx);
}

export interface BrokerageIdentity {
  brokerageLegalName: string;
  teamName: string | null;
  brokerageLicenseNumber: string | null;
  brokeragePostalAddress: string | null;
}

/**
 * The brokerage identity outbound marketing must render (R-GATE-12, A7f), read in the caller's
 * transaction (any member may read tenant_settings). api/comms feeds it into core's
 * `renderedFacts` / gate input (`brokerageNamePresent`, `postalAddressPresent`).
 */
export async function loadBrokerageIdentity(tx: Tx): Promise<BrokerageIdentity | null> {
  const r = await sql<{ brokerage_legal_name: string; team_name: string | null; brokerage_license_number: string | null; brokerage_postal_address: string | null }>`
    SELECT brokerage_legal_name, team_name, brokerage_license_number, brokerage_postal_address FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return { brokerageLegalName: x.brokerage_legal_name, teamName: x.team_name, brokerageLicenseNumber: x.brokerage_license_number, brokeragePostalAddress: x.brokerage_postal_address };
}
